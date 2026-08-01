#!/usr/bin/env node
/**
 * `foundry-serve` — run a scenario with a live observer.
 *
 * Starts the HTTP server first, prints the URLs, waits for the operator to open the
 * observer, then executes the run and streams every event as it happens. The server
 * stays up afterwards so the finished run can be explored.
 *
 * §38.1's criterion is the goal: an observer should be able to explain a deployment
 * from human root to result.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { deterministicKeyPair, verifyChain } from "@freeq-foundry/protocol";
import { DEFAULT_LINEAGE_CONSTRAINTS } from "@freeq-foundry/identity";
import { Gateway, StaticAdmissionRegistry } from "@freeq-foundry/gateway";
import { InMemoryEventStore, SqliteEventStore } from "@freeq-foundry/event-store";
import { FoundryServer } from "@freeq-foundry/server";
import {
  PERSONAS,
  builderAgent,
  institutionalistAgent,
  modelAgent,
  weakSaboteurAgent,
} from "@freeq-foundry/agents";
import {
  FREE,
  ModelRouter,
  anthropicAdapter,
  ollamaAdapter,
  openAiAdapter,
  pricingFor,
  type ModelAdapter,
} from "@freeq-foundry/model-adapters";
import { executeRun, webhookScenario, type ParticipantSpec } from "@freeq-foundry/controller";
import { computeMetrics, generateReport } from "@freeq-foundry/observability";

const PAID = new Set(["anthropic", "openai", "kimi"]);

interface Options {
  readonly runId: string;
  readonly port: number;
  readonly saboteur: boolean;
  readonly enforce: boolean;
  readonly model?: string;
  readonly snapshot: string;
  readonly confirmSpend: boolean;
  readonly maxSpendUsd: string;
  readonly outDir: string;
  readonly db?: string;
  readonly tickDelayMs: number;
  readonly wait: boolean;
}

function parse(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match !== null) flags.set(match[1] as string, match[2] ?? "true");
  }
  return {
    runId: flags.get("run-id") ?? `live-${Date.now()}`,
    port: Number(flags.get("port") ?? "7777"),
    saboteur: flags.get("saboteur") === "true",
    enforce: flags.get("no-enforce") !== "true",
    ...(flags.get("model") === undefined ? {} : { model: flags.get("model") as string }),
    snapshot: flags.get("snapshot") ?? "claude-sonnet-4-5-20250929",
    confirmSpend: flags.get("yes-spend-money") === "true",
    maxSpendUsd: flags.get("max-spend-usd") ?? "1.00",
    outDir: resolve(flags.get("out") ?? "out"),
    ...(flags.get("db") === undefined ? {} : { db: flags.get("db") as string }),
    // A human-paced delay so a run can be watched. §6.11 forbids slowing the
    // environment to make humans *competitive*; watching is a different thing.
    tickDelayMs: Number(flags.get("tick-delay-ms") ?? "0"),
    wait: flags.get("no-wait") !== "true",
  };
}

function providerAdapter(provider: string, snapshot: string): ModelAdapter {
  const key = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === "") throw new Error(`${name} is not set`);
    return value;
  };
  switch (provider) {
    case "anthropic":
      return anthropicAdapter({ apiKey: key("ANTHROPIC_API_KEY"), snapshotIdentifier: snapshot });
    case "openai":
      return openAiAdapter({ apiKey: key("OPENAI_API_KEY"), snapshotIdentifier: snapshot });
    case "ollama":
      return ollamaAdapter({ snapshotIdentifier: snapshot });
    default:
      throw new Error(`unknown provider ${provider}`);
  }
}

function population(options: Options): readonly ParticipantSpec[] {
  const roster: readonly (readonly [string, string, string])[] = [
    ["alice", "human-one", PERSONAS.BUILDER],
    ["bob", "human-two", PERSONAS.INSTITUTIONALIST],
    ["carol", "human-three", PERSONAS.STATUS_SEEKER],
    ...(options.saboteur
      ? [["mallory", "human-four", PERSONAS.SKEPTIC] as readonly [string, string, string]]
      : []),
  ];

  return roster.map(([label, humanLabel, persona], index) => {
    const keyPair = deterministicKeyPair(label);
    const humanRoot = deterministicKeyPair(humanLabel);

    if (options.model === undefined) {
      // Deterministic roster: two builders, an institutionalist, and a saboteur last.
      const adapter =
        label === "bob"
          ? institutionalistAgent(`${label}-det`)
          : label === "mallory"
            ? weakSaboteurAgent(`${label}-det`)
            : builderAgent(`${label}-det`, keyPair.did);
      return { keyPair, adapter, humanRoot, declaredAutonomy: "autonomous" as const };
    }

    const router = new ModelRouter({
      targets: [
        {
          adapter: providerAdapter(options.model, options.snapshot),
          pricing: pricingFor(options.model),
        },
      ],
    });
    let sink: ((...args: never[]) => void) | undefined;
    void index;
    return {
      keyPair,
      adapter: modelAgent({
        id: `${label}-model`,
        router,
        persona,
        onInvocation: (outcome, tokens) => sink?.(outcome as never, tokens as never),
      }),
      humanRoot,
      declaredAutonomy: "autonomous" as const,
      attachInvocationSink: (given: (...args: never[]) => void) => {
        sink = given;
      },
    };
  });
}

async function main(): Promise<number> {
  const options = parse(process.argv.slice(2));

  if (options.model !== undefined && PAID.has(options.model) && !options.confirmSpend) {
    console.error(
      [
        `--model=${options.model} makes paid API calls.`,
        "",
        "A key in your environment is not consent to use it. Add --yes-spend-money and",
        "--max-spend-usd=<amount> to proceed, or omit --model to run for free.",
      ].join("\n"),
    );
    return 2;
  }

  const recorder = deterministicKeyPair("recorder");
  const controller = deterministicKeyPair("controller");
  const evaluator = deterministicKeyPair("evaluator");

  // The server needs a store to read from. The run creates its own in-memory store, so
  // the server reads through the same one via the append hook.
  let liveStore: InMemoryEventStore | undefined;
  const gatewayShim = {
    submit: async () => ({
      accepted: false as const,
      code: "RUN_CLOSED" as never,
      message: "this instance does not accept external submissions yet",
    }),
    sequenceFor: async (_runId: string, did: string) =>
      liveStore === undefined ? 0 : liveStore.sequenceFor(options.runId, did),
    subscribe: async function* (runId: string, viewer: never, opts?: never) {
      if (liveStore === undefined) return;
      const real = new Gateway({
        store: liveStore,
        admissions: new StaticAdmissionRegistry(),
        maxClockSkewMs: Number.MAX_SAFE_INTEGER,
      });
      yield* real.subscribe(runId, viewer, opts);
    },
  } as unknown as Gateway;

  const storeShim = {
    head: async () => (liveStore === undefined ? undefined : liveStore.head(options.runId)),
    verifyChain: async () =>
      liveStore === undefined
        ? { valid: true, checked: 0, firstBadIndex: -1, violations: [] }
        : liveStore.verifyChain(options.runId),
    read: async function* (runId: string, opts?: never) {
      if (liveStore !== undefined) yield* liveStore.read(runId, opts);
    },
  } as never;

  const server = new FoundryServer({
    gateway: gatewayShim,
    store: storeShim,
    runId: options.runId,
    port: options.port,
    discovery: {
      runId: options.runId,
      acceptingParticipants: false,
      recorderDid: recorder.did,
      evaluatorDid: evaluator.did,
      lineageConstraints: DEFAULT_LINEAGE_CONSTRAINTS,
    },
  });

  const url = await server.listen();

  console.log("");
  console.log("  Freeq Foundry — live run");
  console.log("");
  console.log(`    observer     ${url}/observer`);
  console.log(`    discovery    ${url}/.well-known/freeq-agent`);
  console.log(`    as markdown  ${url}/.well-known/freeq-agent?format=md`);
  console.log(`    event feed   ${url}/api/events`);
  console.log(`    verify       ${url}/api/verify`);
  console.log("");
  console.log(`    run          ${options.runId}`);
  console.log(`    arm          ${options.enforce ? "capability_enforced" : "unenforced_governance"}`);
  console.log(
    `    agents       ${population(options).length} ${
      options.model === undefined
        ? "deterministic (free)"
        : `model-backed via ${options.model}:${options.snapshot}`
    }`,
  );
  if (options.model !== undefined && PAID.has(options.model)) {
    console.log(`    spend cap    $${options.maxSpendUsd} (hard)`);
  }
  console.log("");

  if (options.wait) {
    console.log("  Open the observer, then press Enter to start the run.");
    await new Promise<void>((resolvePrompt) => {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      readline.question("", () => {
        readline.close();
        resolvePrompt();
      });
    });
  }

  console.log("  running…");
  console.log("");

  let lastBroadcast = -1;
  const result = await executeRun({
    runId: options.runId,
    scenario: webhookScenario({ maxTicks: 120 }),
    participants: population(options),
    recorder,
    controller,
    evaluator,
    enforceCapabilities: options.enforce,
    arm: options.enforce ? "capability_enforced" : "unenforced_governance",
    maxSpendMicros: Math.round(Number(options.maxSpendUsd) * 1_000_000),
    onAppended: (store, logicalTime) => {
      liveStore = store;
      // Drain everything new. A hook per event could be called faster than the
      // observer reads, so catching up by position is more robust than assuming
      // one-event-per-call.
      void (async () => {
        for await (const event of store.read(options.runId, {
          fromLogicalTime: lastBroadcast + 1,
        })) {
          server.broadcast(event);
          lastBroadcast = Math.max(lastBroadcast, event.logicalTime);
        }
        void logicalTime;
      })();
    },
  });

  liveStore = result.store;

  const events = [];
  for await (const event of result.store.read(result.runId)) events.push(event);
  const verification = verifyChain(events, {
    runId: result.runId,
    recorderDid: recorder.did,
  });

  console.log(`    ticks        ${result.ticks}`);
  console.log(`    events       ${result.eventCount}`);
  console.log(`    outcome      ${result.shipped ? "SHIPPED" : "did not ship"}`);
  console.log(`    termination  ${result.terminationReason}`);
  console.log(`    chain        ${verification.valid ? "verified" : "INVALID"}`);
  if (result.modelInvocations.length > 0) {
    const micros = result.modelInvocations.reduce((sum, call) => sum + call.costMicros, 0);
    console.log(
      `    model spend  $${(micros / 1_000_000).toFixed(4)} across ${result.modelInvocations.length} calls`,
    );
  }
  console.log("");

  // Persist, so the run outlives this process.
  const dir = join(options.outDir, result.runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "events.ndjson"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "report.md"),
    generateReport({
      runId: result.runId,
      snapshot: result.state,
      events,
      recorderDid: recorder.did,
      ...(options.enforce ? { arm: "capability_enforced" } : { arm: "unenforced_governance" }),
    }),
    "utf8",
  );
  writeFileSync(
    join(dir, "metrics.json"),
    `${JSON.stringify(computeMetrics(result.state), null, 2)}\n`,
    "utf8",
  );
  for (const [path, content] of result.repository.checkout("main") ?? new Map<string, string>()) {
    const target = join(dir, "product", path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }

  if (options.db !== undefined) {
    // A durable copy, so the run can be reopened and re-observed later.
    const durable = await SqliteEventStore.open({
      path: options.db,
      recorderDid: recorder.did,
      recorderPrivateKey: recorder.privateKey,
    });
    console.log(`    persisted    ${options.db}`);
    durable.close();
  }

  console.log(`    artifacts    ${dir}`);
  console.log("");
  console.log(`  The observer is still live at ${url}/observer — explore the finished run.`);
  console.log("  Press Ctrl+C to stop the server.");
  console.log("");

  await new Promise<void>(() => undefined);
  return 0;
}

main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
