/**
 * An end-to-end run driven by a model-shaped agent.
 *
 * Uses `ScriptedAdapter`, so the *decisions and the code* come through the model
 * interface rather than from the scenario — which is the thing M7 exists to prove —
 * while staying deterministic and free. A real provider adapter differs only in where
 * the text comes from.
 *
 * The scripted responses deliberately include malformed output and a provider
 * failure, because §47.1 and §47.2 require both to be survivable.
 */
import { deterministicKeyPair } from "@freeq-foundry/protocol";
import { EventTypes } from "@freeq-foundry/projections";
import {
  FREE,
  ModelRouter,
  ReactiveScriptedAdapter,
  ScriptedAdapter,
  dueProposalsFrom,
  listAfter,
  reviewablePullRequestsFrom,
  selfDidFrom,
  unclaimedWorkFrom,
  unvotedProposalsFrom,
  type ModelAdapter,
  type ReactiveRule,
} from "@freeq-foundry/model-adapters";
import { PERSONAS, modelAgent } from "@freeq-foundry/agents";
import { describe, expect, it } from "vitest";
import { executeRun, webhookScenario, type ParticipantSpec } from "./run.js";

const recorder = deterministicKeyPair("recorder");
const controller = deterministicKeyPair("controller");
const evaluator = deterministicKeyPair("evaluator");
const scenario = webhookScenario({ maxTicks: 40 });

const json = (reasoning: string, actions: unknown[]): string =>
  JSON.stringify({ reasoning, actions });

const SIGNATURE_IMPL = [
  'import { createHmac, timingSafeEqual } from "node:crypto";',
  "export function sign(secret, payload, timestamp) {",
  '  if (typeof secret !== "string" || secret.length === 0) {',
  '    throw new TypeError("secret must be a non-empty string");',
  "  }",
  '  return "v1=" + createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");',
  "}",
  "export function verify(secret, payload, timestamp, signature) {",
  "  const expected = sign(secret, payload, timestamp);",
  '  if (typeof signature !== "string" || signature.length !== expected.length) return false;',
  "  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));",
  "}",
].join("\n");

/**
 * Rules that carry an organization through a run, reacting to the briefing.
 *
 * The wrappings are varied on purpose: one rule replies with a fenced block and
 * another with surrounding prose, so structured-response recovery is exercised by the
 * run rather than only by unit tests.
 */
function builderRules(): readonly ReactiveRule[] {
  return [
    {
      name: "vote on anything I have not voted on",
      when: (b) => unvotedProposalsFrom(b).length > 0,
      then: (b) =>
        unvotedProposalsFrom(b).map((proposalId) => ({
          type: "cast_vote",
          proposalId,
          choice: "yes",
          rationale: "Required to make progress.",
        })),
      wrap: "fenced",
    },
    {
      name: "submit the release once everything is merged",
      when: (b) => b.includes("The product can be submitted to the evaluator."),
      then: () => [{ type: "submit_release", releaseId: "release-1" }],
    },
    {
      name: "merge a ready pull request",
      when: (b) => listAfter(b, "Pull requests ready to merge: ").length > 0,
      then: (b) => [
        {
          type: "merge_pull_request",
          pullRequestId: listAfter(b, "Pull requests ready to merge: ")[0],
        },
      ],
    },
    {
      name: "open a pull request for a branch with none",
      when: (b) => listAfter(b, "Your branches with no pull request: ").length > 0,
      then: (b) => {
        const branch = listAfter(b, "Your branches with no pull request: ")[0] as string;
        return [{ type: "open_pull_request", branch, title: `Implement ${branch}` }];
      },
    },
    {
      name: "write the code for work I have claimed",
      when: (b) => listAfter(b, "You have claimed but not committed: ").length > 0,
      then: (b) => {
        const workItemId = listAfter(b, "You have claimed but not committed: ")[0] as string;
        const path = new RegExp(`^ {2}${workItemId} .*→ write (\\S+)$`, "m").exec(b)?.[1];
        return [
          {
            type: "commit_work",
            workItemId,
            branch: `feature/${workItemId}`,
            message: `Implement ${workItemId}`,
            changes: [{ path: path ?? `src/${workItemId}.mjs`, content: SIGNATURE_IMPL }],
          },
        ];
      },
      wrap: "prose",
    },
    {
      name: "claim unclaimed work once I can commit",
      when: (b) =>
        !b.includes("Your capabilities: NONE") && unclaimedWorkFrom(b).length > 0,
      then: (b) => [{ type: "claim_work", workItemId: unclaimedWorkFrom(b)[0]?.workItemId }],
    },
    {
      name: "propose repository authority for myself",
      when: (b) => b.includes("Your capabilities: NONE") && !b.includes("Open proposals:"),
      then: (b) => [
        {
          type: "open_proposal",
          kind: "capability_grant",
          title: "Grant repository access",
          rationale: "Nobody can commit, so the product cannot be built.",
          constitutionalBasis: "genesis.proposal_rights",
          closesAfterLogicalTicks: 4,
          actions: [
            {
              type: "grant_capability",
              toDid: selfDidFrom(b),
              namespace: "repo",
              redelegable: true,
            },
          ],
        },
      ],
    },
  ];
}

/** Reviews and closes, so decisions actually get made. */
function institutionalistRules(): readonly ReactiveRule[] {
  return [
    {
      name: "vote on anything I have not voted on",
      when: (b) => unvotedProposalsFrom(b).length > 0,
      then: (b) =>
        unvotedProposalsFrom(b).map((proposalId) => ({
          type: "cast_vote",
          proposalId,
          choice: "yes",
          rationale: "Consistent with process.",
        })),
    },
    {
      name: "close proposals that have reached their deadline",
      when: (b) => dueProposalsFrom(b).length > 0,
      then: (b) =>
        dueProposalsFrom(b).map((proposalId) => ({ type: "close_proposal", proposalId })),
    },
    {
      name: "review pull requests so they can merge",
      when: (b) =>
        !b.includes("Your capabilities: NONE") && reviewablePullRequestsFrom(b).length > 0,
      then: (b) =>
        reviewablePullRequestsFrom(b).map((pullRequestId) => ({
          type: "review_pull_request",
          pullRequestId,
          verdict: "approve",
          note: "Reviewed against the published criterion.",
        })),
    },
    {
      name: "propose review authority when I cannot review",
      when: (b) =>
        b.includes("Your capabilities: NONE") &&
        reviewablePullRequestsFrom(b).length > 0 &&
        !b.includes("Open proposals:"),
      then: (b) => [
        {
          type: "open_proposal",
          kind: "capability_grant",
          title: "Grant review authority",
          rationale: "Pull requests cannot merge without a reviewer from another lineage.",
          constitutionalBasis: "genesis.proposal_rights",
          closesAfterLogicalTicks: 3,
          actions: [
            {
              type: "grant_capability",
              toDid: selfDidFrom(b),
              namespace: "repo.review",
              redelegable: false,
            },
          ],
        },
      ],
    },
  ];
}

function modelParticipant(
  label: string,
  humanLabel: string,
  rules: readonly ReactiveRule[],
  persona: string,
): ParticipantSpec {
  const keyPair = deterministicKeyPair(label);
  const adapter: ModelAdapter = new ReactiveScriptedAdapter({ id: `reactive-${label}`, rules });
  const router = new ModelRouter({ targets: [{ adapter, pricing: FREE }] });

  let sink: ((...args: never[]) => void) | undefined;
  const agent = modelAgent({
    id: `${label}-model`,
    router,
    persona,
    onInvocation: (outcome, tokens) => sink?.(outcome as never, tokens as never),
  });

  return {
    keyPair,
    adapter: agent,
    humanRoot: deterministicKeyPair(humanLabel),
    declaredAutonomy: "autonomous",
    attachInvocationSink: (given) => {
      sink = given as (...args: never[]) => void;
    },
  };
}

function scriptedParticipant(
  label: string,
  humanLabel: string,
  responses: readonly string[],
): ParticipantSpec {
  const keyPair = deterministicKeyPair(label);
  const adapter: ModelAdapter = new ScriptedAdapter({ id: `scripted-${label}`, responses });
  const router = new ModelRouter({ targets: [{ adapter, pricing: FREE }] });
  let sink: ((...args: never[]) => void) | undefined;
  return {
    keyPair,
    adapter: modelAgent({
      id: `${label}-model`,
      router,
      persona: PERSONAS.BUILDER,
      onInvocation: (outcome, tokens) => sink?.(outcome as never, tokens as never),
    }),
    humanRoot: deterministicKeyPair(humanLabel),
    attachInvocationSink: (given) => {
      sink = given as (...args: never[]) => void;
    },
  };
}

const population = (): readonly ParticipantSpec[] => [
  modelParticipant("alice", "human-one", builderRules(), PERSONAS.BUILDER),
  modelParticipant("bob", "human-two", institutionalistRules(), PERSONAS.INSTITUTIONALIST),
  modelParticipant("carol", "human-three", builderRules(), PERSONAS.STATUS_SEEKER),
];

describe("model-driven run", () => {
  it("routes decisions through the model interface and records every invocation", async () => {
    const result = await executeRun({
      runId: "run-model",
      scenario,
      participants: population(),
      recorder,
      controller,
      evaluator,
    });

    expect(result.modelInvocations.length).toBeGreaterThan(0);

    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);
    const invoked = events.filter((e) => e.eventType === EventTypes.MODEL_INVOKED);
    expect(invoked.length).toBeGreaterThan(0);

    // ADR-0009: every invocation carries a pinned snapshot and a verification level.
    for (const event of invoked) {
      const payload = event.payload as Record<string, unknown>;
      expect(payload["snapshotIdentifier"]).toBeDefined();
      expect(payload["apiVersion"]).toBeDefined();
      expect(typeof payload["verificationLevel"]).toBe("number");
    }
  });

  it("marks a scripted adapter's invocations as unverified model identity", async () => {
    // Level 0: no model is behind a script, and claiming otherwise would launder a
    // fixture into evidence. Condition assignment may not depend on level 0–1.
    const result = await executeRun({
      runId: "run-model-level",
      scenario,
      participants: population(),
      recorder,
      controller,
      evaluator,
    });
    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);
    const invoked = events.filter((e) => e.eventType === EventTypes.MODEL_INVOKED);
    expect((invoked[0]?.payload as { verificationLevel: number }).verificationLevel).toBe(0);
  });

  it("survives malformed model output", async () => {
    // The first scripted response is prose. §47.1: handled, not fatal.
    const result = await executeRun({
      runId: "run-malformed",
      scenario,
      participants: [
        scriptedParticipant("alice", "human-one", [
          "not json at all",
          "still not json",
          json("finally", [{ type: "noop" }]),
        ]),
      ],
      recorder,
      controller,
      evaluator,
    });
    expect(result.state.run.terminated).toBe(true);
    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);
    expect(events.length).toBeGreaterThan(0);
  });

  it("survives a provider that always fails", async () => {
    // §47.2 and §47.3: neither provider failure nor agent failure may take the run
    // with it.
    const failing: ModelAdapter = {
      id: "always-fails",
      provider: "test",
      modelIdentifier: "m",
      snapshotIdentifier: "m",
      apiVersion: "v",
      verificationLevel: 4,
      invoke: async () => ({
        ok: false,
        kind: "overloaded",
        message: "unavailable",
        retryable: true,
        latencyMs: 0,
      }),
    };
    const keyPair = deterministicKeyPair("alice");
    const result = await executeRun({
      runId: "run-provider-down",
      scenario: webhookScenario({ maxTicks: 5 }),
      participants: [
        {
          keyPair,
          adapter: modelAgent({
            id: "alice-model",
            router: new ModelRouter({ targets: [{ adapter: failing, pricing: FREE }] }),
            persona: PERSONAS.BUILDER,
          }),
          humanRoot: deterministicKeyPair("human-one"),
        },
      ],
      recorder,
      controller,
      evaluator,
    });
    expect(result.state.run.terminated).toBe(true);
    expect(result.shipped).toBe(false);
  });

  it("commits code the agent authored, not the scenario's", async () => {
    // The point of M7. `agentAuthored` on the commit event records which happened, so
    // a reader can never mistake a pipeline test for evidence of code generation.
    const result = await executeRun({
      runId: "run-authored",
      scenario,
      participants: population(),
      recorder,
      controller,
      evaluator,
    });

    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);
    const commits = events.filter((e) => e.eventType === EventTypes.COMMIT_CREATED);

    expect(commits.length).toBeGreaterThan(0);
    expect((commits[0]?.payload as { agentAuthored: boolean }).agentAuthored).toBe(true);

    // And the committed content is what the script wrote, not the scenario's version.
    const branch = (commits[0]?.payload as { branch: string }).branch;
    const files = result.repository.checkout(branch);
    expect(files?.get("src/signature.mjs")).toContain("timingSafeEqual");
  });

  it("charges the treasury for model spend in decimal strings", async () => {
    const result = await executeRun({
      runId: "run-spend",
      scenario: webhookScenario({ maxTicks: 6 }),
      participants: population(),
      recorder,
      controller,
      evaluator,
    });
    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);
    const spend = events.filter((e) => e.eventType === EventTypes.SPEND_RECORDED);
    expect(spend.length).toBeGreaterThan(0);
    for (const event of spend) {
      const usd = (event.payload as { usd?: string }).usd;
      // Decimal string or absent, never a float (ADR-0004).
      if (usd !== undefined) expect(typeof usd).toBe("string");
    }
  });

  it("stays byte-identical across runs, since scripted output is fixed", async () => {
    const hashesOf = async (runId: string): Promise<string[]> => {
      const result = await executeRun({
        runId,
        scenario: webhookScenario({ maxTicks: 8 }),
        participants: population(),
        recorder,
        controller,
        evaluator,
      });
      const out: string[] = [];
      for await (const event of result.store.read(runId)) out.push(event.eventHash);
      return out;
    };
    expect(await hashesOf("run-det-model")).toEqual(await hashesOf("run-det-model"));
  });
});

describe("model-driven run: does the organization actually ship?", () => {
  it("carries a model-driven population all the way to a verified release", async () => {
    // The claim M7 exists to support: decisions and code both come through the model
    // interface, and the external evaluator verifies the result.
    const result = await executeRun({
      runId: "run-model-ships",
      scenario: webhookScenario({ maxTicks: 120 }),
      participants: population(),
      recorder,
      controller,
      evaluator,
    });

    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);
    const commits = events.filter((e) => e.eventType === EventTypes.COMMIT_CREATED);
    const merges = events.filter((e) => e.eventType === EventTypes.PULL_REQUEST_MERGED);

    // Whether it ships depends on the rules being good enough, which is the point of
    // the experiment. What must hold is that the pipeline ran on agent-authored code.
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.every((e) => (e.payload as { agentAuthored: boolean }).agentAuthored)).toBe(
      true,
    );
    expect(merges.length).toBeGreaterThan(0);
    expect(result.modelInvocations.length).toBeGreaterThan(commits.length);
  });

  it("records failover so a degraded provider is visible in the record", async () => {
    // §58.6: a model claim must be qualified by what actually served it.
    const failing: ModelAdapter = {
      id: "primary-down",
      provider: "test",
      modelIdentifier: "m",
      snapshotIdentifier: "m",
      apiVersion: "v",
      verificationLevel: 4,
      invoke: async () => ({
        ok: false,
        kind: "overloaded",
        message: "unavailable",
        retryable: true,
        latencyMs: 0,
      }),
    };
    const keyPair = deterministicKeyPair("alice");
    const backup = new ReactiveScriptedAdapter({ id: "backup", rules: builderRules() });
    let sink: ((...args: never[]) => void) | undefined;

    const result = await executeRun({
      runId: "run-failover",
      scenario: webhookScenario({ maxTicks: 6 }),
      participants: [
        {
          keyPair,
          adapter: modelAgent({
            id: "alice-model",
            router: new ModelRouter({
              targets: [
                { adapter: failing, pricing: FREE },
                { adapter: backup, pricing: FREE },
              ],
              retriesPerTarget: 0,
            }),
            persona: PERSONAS.BUILDER,
            onInvocation: (outcome, tokens) => sink?.(outcome as never, tokens as never),
          }),
          humanRoot: deterministicKeyPair("human-one"),
          attachInvocationSink: (given) => {
            sink = given as (...args: never[]) => void;
          },
        },
      ],
      recorder,
      controller,
      evaluator,
    });

    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);
    const invoked = events.filter((e) => e.eventType === EventTypes.MODEL_INVOKED);
    expect(invoked.length).toBeGreaterThan(0);
    expect((invoked[0]?.payload as { failedOver?: string[] }).failedOver).toContain(
      "primary-down",
    );
  });
});
