import { deterministicKeyPair } from "@freeq-foundry/protocol";
import { NodeSubprocessSandbox } from "@freeq-foundry/sandbox";
import { describe, expect, it } from "vitest";
import {
  buildCriterionModule,
  evaluateRelease,
  packageTests,
  publicCriteria,
  verifyEvaluationResult,
  type AcceptanceCriterion,
} from "./evaluator.js";

const evaluator = deterministicKeyPair("evaluator");
const impostor = deterministicKeyPair("impostor");
const sandbox = new NodeSubprocessSandbox();
const COMMIT = `sha256:${"a".repeat(64)}` as const satisfies string as `sha256:${string}`;

const criterion = (
  id: string,
  mandatory: boolean,
  body: string,
): AcceptanceCriterion => ({
  id,
  description: `criterion ${id}`,
  mandatory,
  testSource: buildCriterionModule(body),
});

const product = (impl: string): Map<string, string> =>
  new Map([["src/add.mjs", impl]]);

const GOOD = "export const add = (a, b) => a + b;";
const BAD = "export const add = (a, b) => a * b;";

const evaluate = (
  files: Map<string, string>,
  criteria: readonly AcceptanceCriterion[],
) =>
  evaluateRelease({
    releaseId: "r1",
    commitHash: COMMIT,
    files,
    bundle: packageTests("bundle-1", criteria),
    sandbox,
    evaluatorDid: evaluator.did,
    evaluatorPrivateKey: evaluator.privateKey,
  });

const ADD_TEST = [
  'const { add } = await import("./src/add.mjs");',
  'assertEqual(add(2, 3), 5, "add should sum");',
];

describe("protected tests", () => {
  it("never exposes test source to the organization", () => {
    // §30: an agent that could read the test could satisfy it without the code
    // working.
    const bundle = packageTests("b", [criterion("c1", true, ADD_TEST.join("\n"))]);
    const visible = publicCriteria(bundle);
    expect(visible[0]).toEqual({ id: "c1", description: "criterion c1", mandatory: true });
    expect(JSON.stringify(visible)).not.toContain("assertEqual");
    expect(JSON.stringify(visible)).not.toContain("import");
  });

  it("hashes the bundle so the test set can be shown to be fixed", () => {
    // A reader can later check published tests against the hash and confirm they
    // were not changed to suit the result.
    const a = packageTests("b", [criterion("c1", true, "assert(true, \"x\");")]);
    const b = packageTests("b", [criterion("c1", true, "assert(true, \"x\");")]);
    const c = packageTests("b", [criterion("c1", true, "assert(false, \"x\");")]);
    expect(a.bundleHash).toBe(b.bundleHash);
    expect(a.bundleHash).not.toBe(c.bundleHash);
  });
});

describe("evaluation", () => {
  it("verifies a release that passes every mandatory criterion", async () => {
    const result = await evaluate(product(GOOD), [
      criterion("adds", true, ADD_TEST.join("\n")),
    ]);
    expect(result.verified).toBe(true);
    expect(result.mandatoryPassed).toBe(1);
    expect(result.acceptanceFraction).toBe("1");
  });

  it("rejects a release whose code is wrong", async () => {
    const result = await evaluate(product(BAD), [
      criterion("adds", true, ADD_TEST.join("\n")),
    ]);
    expect(result.verified).toBe(false);
    expect(result.criteria[0]?.detail).toContain("ASSERTION FAILED");
  });

  it("does not let an optional failure block verification", async () => {
    const result = await evaluate(product(GOOD), [
      criterion("adds", true, ADD_TEST.join("\n")),
      criterion("nice-to-have", false, 'assert(false, "optional");'),
    ]);
    expect(result.verified).toBe(true);
    expect(result.acceptanceFraction).toBe("1");
  });

  it("reports a partial fraction", async () => {
    const result = await evaluate(product(BAD), [
      criterion("adds", true, ADD_TEST.join("\n")),
      criterion("loads", true, 'await import("./src/add.mjs");'),
    ]);
    expect(result.mandatoryPassed).toBe(1);
    expect(result.mandatoryTotal).toBe(2);
    expect(result.acceptanceFraction).toBe("0.5");
  });

  it("refuses to verify a release with no mandatory criteria", async () => {
    // Otherwise an empty scenario could claim success: there would be nothing to
    // have verified.
    const result = await evaluate(product(GOOD), [
      criterion("optional", false, 'assert(true, "x");'),
    ]);
    expect(result.verified).toBe(false);
  });

  it("runs each criterion in its own sandbox invocation", async () => {
    // Sharing one process would let an earlier test mutate state a later one
    // depends on, turning an independent pass into a sequence-dependent one.
    const result = await evaluate(product(GOOD), [
      criterion("sets-global", true, 'globalThis.__leak = 1; assert(true, "x");'),
      criterion("sees-no-leak", true, 'assert(globalThis.__leak === undefined, "state leaked between criteria");'),
    ]);
    expect(result.verified).toBe(true);
  });

  it("fails a criterion whose code does not even load", async () => {
    const result = await evaluate(new Map([["src/add.mjs", "this is not javascript ("]]), [
      criterion("adds", true, ADD_TEST.join("\n")),
    ]);
    expect(result.verified).toBe(false);
    expect(result.criteria[0]?.passed).toBe(false);
  });

  it("times out a criterion that hangs", async () => {
    const result = await evaluateRelease({
      releaseId: "r1",
      commitHash: COMMIT,
      files: product(GOOD),
      bundle: packageTests("b", [criterion("hangs", true, "while (true) {}")]),
      sandbox,
      evaluatorDid: evaluator.did,
      evaluatorPrivateKey: evaluator.privateKey,
      limits: { timeoutMs: 400, maxOutputBytes: 65536, maxFileBytes: 65536, maxFiles: 50 },
    });
    expect(result.criteria[0]?.outcome).toBe("timed_out");
    expect(result.verified).toBe(false);
  });

  it("refuses a tree that occupies the reserved evaluator path", async () => {
    // An organization must not be able to shadow the harness.
    const result = await evaluate(
      new Map([...product(GOOD), ["__criterion__.mjs", 'console.log("PASS");']]),
      [criterion("adds", true, ADD_TEST.join("\n"))],
    );
    expect(result.criteria[0]?.outcome).toBe("rejected");
    expect(result.criteria[0]?.detail).toContain("shadow the harness");
  });

  it("blocks verification when a release contains a secret", async () => {
    // A release that would leak a credential should be reported whatever its tests
    // do (§31).
    const result = await evaluate(
      new Map([
        ...product(GOOD),
        ["config.mjs", 'const key = "AKIAIOSFODNN7EXAMPLE";'],
      ]),
      [criterion("adds", true, ADD_TEST.join("\n"))],
    );
    expect(result.criteria[0]?.passed).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.secretFindings.length).toBeGreaterThan(0);
  });

  it("truncates enormous output rather than exceeding the payload ceiling", async () => {
    const result = await evaluate(product(GOOD), [
      criterion("noisy", true, 'for (let i = 0; i < 500; i++) console.log("x".repeat(50)); assert(true, "x");'),
    ]);
    expect(result.criteria[0]?.detail.length).toBeLessThan(2200);
  });
});

describe("evaluator signature", () => {
  it("signs its verdict", async () => {
    const result = await evaluate(product(GOOD), [
      criterion("adds", true, ADD_TEST.join("\n")),
    ]);
    expect(verifyEvaluationResult(result)).toBe(true);
  });

  it("detects a forged verdict", async () => {
    // §6.7: the organization cannot vote itself successful, and any consumer of
    // the dataset can check.
    const result = await evaluate(product(BAD), [
      criterion("adds", true, ADD_TEST.join("\n")),
    ]);
    const forged = { ...result, verified: true, mandatoryPassed: 1 };
    expect(verifyEvaluationResult(forged)).toBe(false);
  });

  it("detects a verdict attributed to the wrong evaluator", async () => {
    const result = await evaluate(product(GOOD), [
      criterion("adds", true, ADD_TEST.join("\n")),
    ]);
    expect(verifyEvaluationResult({ ...result, evaluatorDid: impostor.did })).toBe(false);
  });

  it("ties a verdict to a specific commit", async () => {
    const result = await evaluate(product(GOOD), [
      criterion("adds", true, ADD_TEST.join("\n")),
    ]);
    expect(result.commitHash).toBe(COMMIT);
    const otherCommit = `sha256:${"b".repeat(64)}` as `sha256:${string}`;
    expect(verifyEvaluationResult({ ...result, commitHash: otherCommit })).toBe(false);
  });
});
