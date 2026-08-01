import { describe, expect, it } from "vitest";
import {
  ModelRouter,
  ReplayAdapter,
  ScriptedAdapter,
  InvocationRecorder,
  hashRequest,
  type RecordedInvocation,
} from "./replay.js";
import { anthropicAdapter, openAiAdapter } from "./providers.js";
import { extractJson, parseStructuredResponse, repairPrompt } from "./structured.js";
import {
  classifyStatus,
  invocationMicros,
  microsToUsdString,
  type HttpTransport,
  type ModelAdapter,
  type ModelRequest,
} from "./types.js";
import { FREE, pricingFor } from "./pricing.js";

const request: ModelRequest = {
  messages: [
    { role: "system", content: "be useful" },
    { role: "user", content: "what now?" },
  ],
  maxOutputTokens: 1024,
};

const transport = (
  status: number,
  body: unknown,
  capture?: (body: string, headers: Record<string, string>) => void,
): HttpTransport => async (_url, init) => {
  capture?.(init.body, init.headers as Record<string, string>);
  return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
};

describe("cost arithmetic", () => {
  it("computes cost in integer micros", () => {
    const cost = invocationMicros(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { inputMicrosPerMillion: 3_000_000, outputMicrosPerMillion: 15_000_000 },
    );
    expect(cost).toBe(18_000_000);
    expect(Number.isInteger(cost)).toBe(true);
  });

  it("rounds up, so spend is never under-reported against a ceiling", () => {
    const cost = invocationMicros(
      { inputTokens: 1, outputTokens: 0 },
      { inputMicrosPerMillion: 3_000_000, outputMicrosPerMillion: 0 },
    );
    expect(cost).toBe(3);
  });

  it("formats micros as a decimal string without float drift", () => {
    expect(microsToUsdString(1_500_000)).toBe("1.5");
    expect(microsToUsdString(100_000)).toBe("0.1");
    expect(microsToUsdString(200_000)).toBe("0.2");
    expect(microsToUsdString(300_000)).toBe("0.3");
    expect(microsToUsdString(0)).toBe("0");
    expect(microsToUsdString(1)).toBe("0.000001");
    // The sum that famously breaks in binary floating point.
    expect(microsToUsdString(100_000 + 200_000)).toBe("0.3");
  });

  it("charges nothing for a local runtime but does not treat it as unpriced", () => {
    expect(pricingFor("ollama")).toEqual(FREE);
  });

  it("defaults an unknown provider to the most expensive tier", () => {
    // Defaulting to zero would let an unpriced model spend against a hard ceiling
    // without registering.
    const unknown = pricingFor("some-new-provider");
    expect(unknown.inputMicrosPerMillion).toBeGreaterThan(0);
  });
});

describe("status classification", () => {
  it("treats rate limits and overload as retryable", () => {
    expect(classifyStatus(429).retryable).toBe(true);
    expect(classifyStatus(529).retryable).toBe(true);
    expect(classifyStatus(503).retryable).toBe(true);
  });

  it("treats auth and bad requests as terminal", () => {
    expect(classifyStatus(401)).toEqual({ kind: "auth", retryable: false });
    expect(classifyStatus(400).retryable).toBe(false);
  });
});

describe("OpenAI-compatible adapter", () => {
  it("parses a successful response", async () => {
    const adapter = openAiAdapter({
      apiKey: "k",
      snapshotIdentifier: "gpt-4o-2024-08-06",
      transport: transport(200, {
        model: "gpt-4o-2024-08-06",
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }),
      now: () => 1000,
    });
    const response = await adapter.invoke(request);
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.text).toBe("hello");
      expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
      expect(response.returnedModelIdentifier).toBe("gpt-4o-2024-08-06");
    }
  });

  it("reports the returned identifier so substitution is detectable", async () => {
    // ADR-0009: recording what we asked for proves intent; recording what came back
    // detects silent endpoint substitution.
    const adapter = openAiAdapter({
      apiKey: "k",
      snapshotIdentifier: "gpt-4o-2024-08-06",
      transport: transport(200, {
        model: "gpt-4o-2024-11-20",
        choices: [{ message: { content: "x" } }],
        usage: {},
      }),
    });
    const response = await adapter.invoke(request);
    expect(response.ok && response.returnedModelIdentifier).toBe("gpt-4o-2024-11-20");
    expect(adapter.snapshotIdentifier).toBe("gpt-4o-2024-08-06");
  });

  it("classifies a rate limit as retryable rather than throwing", async () => {
    const adapter = openAiAdapter({
      apiKey: "k",
      snapshotIdentifier: "m",
      transport: transport(429, "slow down"),
    });
    const response = await adapter.invoke(request);
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.kind).toBe("rate_limited");
      expect(response.retryable).toBe(true);
    }
  });

  it("survives malformed provider output", async () => {
    const adapter = openAiAdapter({
      apiKey: "k",
      snapshotIdentifier: "m",
      transport: transport(200, "not json at all"),
    });
    const response = await adapter.invoke(request);
    expect(response.ok).toBe(false);
  });

  it("survives a transport that throws", async () => {
    const adapter = openAiAdapter({
      apiKey: "k",
      snapshotIdentifier: "m",
      transport: async () => {
        throw new Error("socket closed");
      },
    });
    const response = await adapter.invoke(request);
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.kind).toBe("network");
  });

  it("omits the Authorization header for a keyless local runtime", async () => {
    // Sending an empty Authorization header makes some local servers reject outright.
    let seen: Record<string, string> = {};
    const adapter = openAiAdapter({
      apiKey: "",
      snapshotIdentifier: "m",
      transport: transport(
        200,
        { choices: [{ message: { content: "x" } }], usage: {} },
        (_body, headers) => {
          seen = headers;
        },
      ),
    });
    await adapter.invoke(request);
    expect(seen["authorization"]).toBeUndefined();
  });
});

describe("Anthropic adapter", () => {
  it("lifts the system prompt out of the message list", async () => {
    // Anthropic takes it as a top-level field; passing it through as a message would
    // be silently dropped or rejected.
    let body: Record<string, unknown> = {};
    const adapter = anthropicAdapter({
      apiKey: "k",
      snapshotIdentifier: "claude-sonnet-4-5-20250929",
      transport: transport(
        200,
        { model: "claude-sonnet-4-5-20250929", content: [{ type: "text", text: "hi" }], usage: {} },
        (raw) => {
          body = JSON.parse(raw) as Record<string, unknown>;
        },
      ),
    });
    await adapter.invoke(request);
    expect(body["system"]).toBe("be useful");
    expect((body["messages"] as unknown[]).length).toBe(1);
  });

  it("concatenates text blocks and ignores non-text ones", async () => {
    // A thinking block is not the response, and §33.8 says the platform should not
    // require hidden reasoning.
    const adapter = anthropicAdapter({
      apiKey: "k",
      snapshotIdentifier: "m",
      transport: transport(200, {
        content: [
          { type: "thinking", thinking: "should not appear" },
          { type: "text", text: "part one " },
          { type: "text", text: "part two" },
        ],
        usage: { input_tokens: 5, output_tokens: 7 },
      }),
    });
    const response = await adapter.invoke(request);
    expect(response.ok && response.text).toBe("part one part two");
    expect(response.ok && response.text).not.toContain("should not appear");
  });

  it("distinguishes a refusal from a malformed response", async () => {
    const adapter = anthropicAdapter({
      apiKey: "k",
      snapshotIdentifier: "m",
      transport: transport(200, { content: [], stop_reason: "refusal" }),
    });
    const response = await adapter.invoke(request);
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.kind).toBe("content_filtered");
  });
});

describe("structured parsing", () => {
  const good = '{"reasoning":"because","actions":[{"type":"noop"}]}';

  it("parses clean JSON", () => {
    const result = parseStructuredResponse(good);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recovered).toBe(false);
      expect(result.value.actions).toHaveLength(1);
    }
  });

  it("recovers from a fenced code block", () => {
    const result = parseStructuredResponse("Here you go:\n```json\n" + good + "\n```");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.recovered).toBe(true);
  });

  it("recovers from surrounding prose", () => {
    const result = parseStructuredResponse(`I think I should do nothing. ${good} Hope that helps!`);
    expect(result.ok).toBe(true);
  });

  it("is string-aware, so code containing braces survives", () => {
    // A naive brace scan truncates any payload containing code, which is most of
    // them in this system.
    const withCode = JSON.stringify({
      reasoning: "writing code",
      actions: [
        {
          type: "commit_work",
          changes: [{ path: "a.mjs", content: 'function f() { return "}"; }' }],
        },
      ],
    });
    const result = parseStructuredResponse(`Sure:\n${withCode}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const change = (result.value.actions[0]?.["changes"] as { content: string }[])[0];
      expect(change?.content).toContain('return "}"');
    }
  });

  it("truncates an over-long action list rather than refusing it", () => {
    const many = JSON.stringify({
      reasoning: "eager",
      actions: Array.from({ length: 20 }, () => ({ type: "noop" })),
    });
    const result = parseStructuredResponse(many, { maxActions: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.actions).toHaveLength(3);
      expect(result.note).toContain("truncated");
    }
  });

  it("refuses output it cannot parse rather than inventing actions", () => {
    // Aggressive repair would let the harness invent actions the model did not
    // request, and an action nobody asked for is worse than a wasted activation.
    for (const text of ["", "I would like to think about this.", "{broken", "[1,2,3]"]) {
      expect(parseStructuredResponse(text).ok, JSON.stringify(text)).toBe(false);
    }
  });

  it("refuses an actions entry without a type", () => {
    expect(
      parseStructuredResponse('{"reasoning":"x","actions":[{"proposalId":"p"}]}').ok,
    ).toBe(false);
  });

  it("quotes the actual failure in a repair prompt", () => {
    const prompt = repairPrompt("no parseable JSON", "I think that...");
    expect(prompt).toContain("no parseable JSON");
    expect(prompt).toContain("I think that...");
    expect(prompt).toContain('"reasoning"');
  });

  it("extracts arrays as well as objects", () => {
    const result = extractJson("prefix [1,2] suffix");
    expect(result.ok && result.value).toEqual([1, 2]);
  });
});

describe("router failover", () => {
  const failing = (kind: "rate_limited" | "auth"): ModelAdapter => ({
    id: `failing-${kind}`,
    provider: "test",
    modelIdentifier: "m",
    snapshotIdentifier: "m",
    apiVersion: "v",
    verificationLevel: 4,
    invoke: async () => ({
      ok: false,
      kind,
      message: "nope",
      retryable: kind === "rate_limited",
      latencyMs: 1,
    }),
  });

  const target = (adapter: ModelAdapter) => ({ adapter, pricing: FREE });

  it("uses the primary when it works", async () => {
    const router = new ModelRouter({
      targets: [target(new ScriptedAdapter({ id: "primary", responses: ["ok"] }))],
    });
    const outcome = await router.route(request);
    expect(outcome.response.ok).toBe(true);
    expect(outcome.adapter.id).toBe("primary");
    expect(outcome.failedOver).toEqual([]);
  });

  it("fails over to the next target and records that it did", async () => {
    // A run where one provider degraded and another carried the load is a different
    // run, and §58.6 requires model claims to be qualified by what served them.
    const router = new ModelRouter({
      targets: [
        target(failing("rate_limited")),
        target(new ScriptedAdapter({ id: "backup", responses: ["recovered"] })),
      ],
      retriesPerTarget: 1,
    });
    const outcome = await router.route(request);
    expect(outcome.response.ok).toBe(true);
    expect(outcome.adapter.id).toBe("backup");
    expect(outcome.failedOver).toHaveLength(1);
    expect(outcome.failedOver[0]?.reason).toContain("rate_limited");
  });

  it("does not retry a terminal failure", async () => {
    let calls = 0;
    const counting: ModelAdapter = {
      ...failing("auth"),
      invoke: async () => {
        calls++;
        return { ok: false, kind: "auth", message: "bad key", retryable: false, latencyMs: 1 };
      },
    };
    const router = new ModelRouter({ targets: [target(counting)], retriesPerTarget: 3 });
    await router.route(request);
    expect(calls).toBe(1);
  });

  it("reports a definite failure when every target fails", async () => {
    const router = new ModelRouter({
      targets: [target(failing("auth")), target(failing("auth"))],
    });
    const outcome = await router.route(request);
    expect(outcome.response.ok).toBe(false);
    expect(outcome.failedOver).toHaveLength(2);
  });

  it("refuses a call that would exceed the remaining budget", async () => {
    // §21.6: the hard limit refuses the call rather than making it and reporting it.
    const router = new ModelRouter({
      targets: [
        {
          adapter: new ScriptedAdapter({ id: "expensive", responses: ["x"] }),
          pricing: { inputMicrosPerMillion: 10_000_000, outputMicrosPerMillion: 10_000_000 },
        },
      ],
      remainingMicros: () => 1,
    });
    const outcome = await router.route(request);
    expect(outcome.response.ok).toBe(false);
    expect(outcome.failedOver[0]?.reason).toContain("remaining");
  });

  it("refuses to be constructed with no targets", () => {
    expect(() => new ModelRouter({ targets: [] })).toThrow();
  });
});

describe("replay", () => {
  const record = (text: string, req: ModelRequest): RecordedInvocation => ({
    invocationId: "mi-1",
    adapterId: "anthropic:snap",
    provider: "anthropic",
    modelIdentifier: "claude",
    snapshotIdentifier: "snap",
    requestHash: hashRequest(req),
    responseText: text,
    usage: { inputTokens: 10, outputTokens: 5 },
    costMicros: 100,
  });

  it("serves a recorded response for the same request", async () => {
    const adapter = new ReplayAdapter({ records: [record("recorded answer", request)] });
    const response = await adapter.invoke(request);
    expect(response.ok && response.text).toBe("recorded answer");
    expect(adapter.misses).toBe(0);
  });

  it("makes a replay of a model-driven run free and exact", async () => {
    const records = [record("one", request), record("two", request)];
    const adapter = new ReplayAdapter({ records });
    expect((await adapter.invoke(request)).ok).toBe(true);
    const second = await adapter.invoke(request);
    expect(second.ok && second.text).toBe("two");
  });

  it("fails loudly when the replay diverges", async () => {
    // A replay that invents a response is not a replay, and the divergence would be
    // invisible in the resulting dataset.
    const adapter = new ReplayAdapter({ records: [record("x", request)] });
    const different: ModelRequest = {
      messages: [{ role: "user", content: "a different question" }],
      maxOutputTokens: 1024,
    };
    const response = await adapter.invoke(different);
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.message).toContain("diverged");
    expect(adapter.misses).toBe(1);
  });

  it("ignores requestId when hashing, since it varies legitimately", () => {
    expect(hashRequest({ ...request, requestId: "a" })).toBe(
      hashRequest({ ...request, requestId: "b" }),
    );
  });

  it("distinguishes requests that differ in content", () => {
    expect(hashRequest(request)).not.toBe(
      hashRequest({ ...request, maxOutputTokens: 2048 }),
    );
  });

  it("inherits verification level rather than asserting one", () => {
    // Claiming level 4 for a replay of a level-1 claim would launder the claim.
    expect(
      new ReplayAdapter({ records: [record("x", request)], verificationLevel: 1 })
        .verificationLevel,
    ).toBe(1);
  });

  it("reports latency as zero rather than fabricating the original", async () => {
    const adapter = new ReplayAdapter({ records: [record("x", request)] });
    const response = await adapter.invoke(request);
    expect(response.ok && response.latencyMs).toBe(0);
  });
});

describe("scripted adapter", () => {
  it("reports verification level 0, since no model is behind it", () => {
    // Condition assignment may not depend on level 0–1, which correctly excludes
    // scripted runs from confirmatory model claims.
    expect(new ScriptedAdapter({ responses: ["x"] }).verificationLevel).toBe(0);
  });

  it("repeats its last response once exhausted", async () => {
    const adapter = new ScriptedAdapter({ responses: ["a", "b"] });
    await adapter.invoke();
    await adapter.invoke();
    const third = await adapter.invoke();
    expect(third.ok && third.text).toBe("b");
  });
});

describe("invocation recorder", () => {
  it("assigns stable ids and preserves cost", () => {
    const recorder = new InvocationRecorder();
    const adapter = new ScriptedAdapter({ id: "s", responses: ["x"] });
    const entry = recorder.record(
      adapter,
      request,
      { ok: true, text: "x", usage: { inputTokens: 1, outputTokens: 2 }, latencyMs: 5 },
      42,
    );
    expect(entry.invocationId).toBe("mi-00001");
    expect(entry.costMicros).toBe(42);
    expect(recorder.records).toHaveLength(1);
  });
});
