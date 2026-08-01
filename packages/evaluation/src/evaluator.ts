/**
 * External product evaluation.
 *
 * §59.10: "Keep the evaluator outside politics. The organization cannot vote itself
 * successful." Two things follow, and both are structural rather than procedural:
 *
 *   1. **Protected tests are never handed to the organization.** Not redacted, not
 *      hashed-and-shown — simply not in the repository and not in any agent's view.
 *      An agent that can read the test can write code that passes it without
 *      working ([§30](../specification.md)).
 *   2. **Only the evaluator's key can declare success.** Governance can propose,
 *      vote, and deploy; it cannot produce the event that ends the run.
 *
 * The evaluator runs the organization's actual code in a sandbox and reports what
 * happened. It never inspects intent.
 *
 * Spec: §30, §6.7, §59.10.
 */
import { hashCanonical, signPayload, verifyPayloadWithDid, type Digest } from "@freeq-foundry/protocol";
import { scanForSecrets, type Sandbox, type SandboxLimits } from "@freeq-foundry/sandbox";
import type { KeyObject } from "node:crypto";

export interface AcceptanceCriterion {
  readonly id: string;
  /** Shown to the organization: what is required, never how it is checked. */
  readonly description: string;
  readonly mandatory: boolean;
  /**
   * Test source, executed in the sandbox against the produced tree.
   *
   * Must never reach an agent. The bundle is hashed so a reader can verify the
   * tests were fixed before the run, without the tests being published during it.
   */
  readonly testSource: string;
}

export interface ProtectedTestBundle {
  readonly bundleId: string;
  readonly criteria: readonly AcceptanceCriterion[];
  /** Hash over the whole bundle, published at run start (§32.6). */
  readonly bundleHash: Digest;
}

/**
 * Package acceptance criteria.
 *
 * Hashing at packaging time is what lets the run manifest commit to a specific test
 * set without disclosing it. A reader can later check the published tests against
 * the hash and confirm they were not changed to suit the result.
 */
export function packageTests(
  bundleId: string,
  criteria: readonly AcceptanceCriterion[],
): ProtectedTestBundle {
  return {
    bundleId,
    criteria,
    bundleHash: hashCanonical(
      criteria.map((criterion) => ({
        id: criterion.id,
        mandatory: criterion.mandatory,
        testHash: hashCanonical(criterion.testSource),
      })) as never,
    ),
  };
}

/**
 * What the organization is told.
 *
 * Descriptions and mandatory flags, never test source. The bundle hash is included
 * so agents can confirm the criteria did not change mid-run — visibility into
 * *stability* without visibility into *content*.
 */
export function publicCriteria(bundle: ProtectedTestBundle): readonly {
  readonly id: string;
  readonly description: string;
  readonly mandatory: boolean;
}[] {
  return bundle.criteria.map((criterion) => ({
    id: criterion.id,
    description: criterion.description,
    mandatory: criterion.mandatory,
  }));
}

export interface CriterionResult {
  readonly id: string;
  readonly mandatory: boolean;
  readonly passed: boolean;
  readonly outcome: string;
  /** Truncated, and never containing test source (§30). */
  readonly detail: string;
  /**
   * Wall-clock duration. **Telemetry, not part of the signed verdict.**
   *
   * §37.3 separates platform telemetry from the canonical record. A real duration
   * varies between runs, so including it in what the evaluator signs would make the
   * signature differ across a replay of identical inputs — which is how this was
   * found, twice: once in a CI event payload and once here, one level deeper.
   */
  readonly durationMs: number;
}

export interface EvaluationResult {
  readonly releaseId: string;
  readonly bundleId: string;
  readonly bundleHash: Digest;
  /** Commit evaluated, so a result is tied to specific code. */
  readonly commitHash: Digest;
  readonly criteria: readonly CriterionResult[];
  readonly mandatoryTotal: number;
  readonly mandatoryPassed: number;
  /** Decimal string: ADR-0004 forbids floats in payloads. */
  readonly acceptanceFraction: string;
  readonly verified: boolean;
  readonly secretFindings: readonly { readonly path: string; readonly pattern: string }[];
  readonly evaluatorDid: string;
  readonly evaluatorSignature: string;
}

export interface EvaluateOptions {
  readonly releaseId: string;
  readonly commitHash: Digest;
  readonly files: ReadonlyMap<string, string>;
  readonly bundle: ProtectedTestBundle;
  readonly sandbox: Sandbox;
  readonly evaluatorDid: string;
  readonly evaluatorPrivateKey: KeyObject;
  readonly limits?: SandboxLimits;
}

/**
 * Reserved root-level path for the criterion under test.
 *
 * At the root, not in a subdirectory: a criterion importing `./src/thing.mjs` should
 * mean what it says. Nesting it forced `../src/…`, which is a footgun for criterion
 * authors and cost this file one debugging round.
 *
 * The evaluator refuses a tree that occupies this path, so the organization cannot
 * shadow the harness.
 */
const TEST_ENTRY = "__criterion__.mjs";

/**
 * Evaluate a release.
 *
 * Each criterion runs in its own sandbox invocation. Sharing one process would let
 * an earlier test mutate global state a later one depends on, which turns an
 * independent pass into a sequence-dependent one.
 */
export async function evaluateRelease(
  options: EvaluateOptions,
): Promise<EvaluationResult> {
  // Scan before executing. A release that would leak a credential should be
  // reported whatever its tests do (§31).
  const secretFindings = scanForSecrets(options.files);

  const results: CriterionResult[] = [];

  for (const criterion of options.bundle.criteria) {
    // The test file lives under a reserved directory that the organization's tree
    // cannot occupy, and it exists only inside this sandbox invocation.
    const files = new Map(options.files);
    if (files.has(TEST_ENTRY)) {
      results.push({
        id: criterion.id,
        mandatory: criterion.mandatory,
        passed: false,
        outcome: "rejected",
        detail:
          "the produced tree occupies the reserved evaluator path; " +
          "an organization must not be able to shadow the harness",
        durationMs: 0,
      });
      continue;
    }
    files.set(TEST_ENTRY, criterion.testSource);

    const run = await options.sandbox.run({
      files,
      entryPoint: TEST_ENTRY,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      profile: "strict",
    });

    results.push({
      id: criterion.id,
      mandatory: criterion.mandatory,
      passed: run.outcome === "succeeded",
      outcome: run.outcome,
      detail: summarize(run.stdout, run.stderr, run.rejection),
      durationMs: run.durationMs,
    });
  }

  const mandatory = results.filter((result) => result.mandatory);
  const mandatoryPassed = mandatory.filter((result) => result.passed).length;

  // A release with no mandatory criteria cannot be "verified": there would be
  // nothing to have verified. That would let an empty scenario claim success.
  const verified =
    mandatory.length > 0 && mandatoryPassed === mandatory.length && secretFindings.length === 0;

  const result: Omit<EvaluationResult, "evaluatorSignature"> = {
    releaseId: options.releaseId,
    bundleId: options.bundle.bundleId,
    bundleHash: options.bundle.bundleHash,
    commitHash: options.commitHash,
    criteria: results,
    mandatoryTotal: mandatory.length,
    mandatoryPassed,
    acceptanceFraction: fraction(mandatoryPassed, mandatory.length),
    verified,
    secretFindings,
    evaluatorDid: options.evaluatorDid,
  };

  return {
    ...result,
    evaluatorSignature: signPayload(
      "EVALUATION",
      signedVerdict(result) as never,
      options.evaluatorPrivateKey,
    ),
  };
}

/**
 * The deterministic part of a verdict: everything except timing.
 *
 * Signing this rather than the whole result means a replay of identical inputs
 * produces an identical signature, which §6.9 requires. Timing is still reported —
 * it is just not attested, because the evaluator is attesting *what happened*, not
 * *how long it took*.
 */
function signedVerdict(
  result: Omit<EvaluationResult, "evaluatorSignature">,
): Record<string, unknown> {
  return {
    releaseId: result.releaseId,
    bundleId: result.bundleId,
    bundleHash: result.bundleHash,
    commitHash: result.commitHash,
    criteria: result.criteria.map((criterion) => ({
      id: criterion.id,
      mandatory: criterion.mandatory,
      passed: criterion.passed,
      outcome: criterion.outcome,
      detail: criterion.detail,
    })),
    mandatoryTotal: result.mandatoryTotal,
    mandatoryPassed: result.mandatoryPassed,
    acceptanceFraction: result.acceptanceFraction,
    verified: result.verified,
    secretFindings: result.secretFindings.map((finding) => ({ ...finding })),
    evaluatorDid: result.evaluatorDid,
  };
}

/**
 * Verify an evaluation result was produced by the run's evaluator.
 *
 * The check that makes §6.7 real: a result the organization forged would fail here,
 * and any consumer of the dataset can run it.
 */
export function verifyEvaluationResult(result: EvaluationResult): boolean {
  try {
    return verifyPayloadWithDid(
      "EVALUATION",
      signedVerdict(result) as never,
      result.evaluatorSignature,
      result.evaluatorDid,
    );
  } catch {
    return false;
  }
}

function fraction(passed: number, total: number): string {
  if (total === 0) return "0";
  if (passed === total) return "1";
  // Two decimal places as a string, so the value survives canonicalization.
  return (passed / total).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

const MAX_DETAIL = 2000;

/**
 * Summarize sandbox output.
 *
 * Truncated because a failing test can print megabytes, and the event payload has a
 * 1 MiB canonical ceiling (ADR-0004).
 */
function summarize(
  stdout: string,
  stderr: string,
  rejection: string | undefined,
): string {
  if (rejection !== undefined) return `rejected: ${rejection}`;
  const combined = [stdout.trim(), stderr.trim()].filter((part) => part !== "").join("\n---\n");
  if (combined.length <= MAX_DETAIL) return combined;
  return `${combined.slice(0, MAX_DETAIL)}\n… truncated ${combined.length - MAX_DETAIL} bytes`;
}

/**
 * Assertion helpers inlined into every criterion.
 *
 * Plain declarations, not exports: the criterion *is* the module, and these live at
 * its top level. Wrapping them in a function body with `export` is a syntax error,
 * which is how the first version of this failed every criterion at once.
 *
 * Criteria are plain Node modules that exit non-zero on failure. No test framework —
 * the sandbox cannot install dependencies without network access, which §6.10
 * forbids.
 */
export const CRITERION_PREAMBLE = `
function assert(condition, message) {
  if (!condition) {
    console.error("ASSERTION FAILED: " + message);
    process.exit(1);
  }
}
function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error("ASSERTION FAILED: " + message + " (expected " + e + ", got " + a + ")");
    process.exit(1);
  }
}
`.trim();

/**
 * Wrap a criterion body into a runnable module.
 *
 * Exported so criterion authors cannot get the wrapping wrong, and so the wrapping
 * is tested once rather than in every scenario.
 */
export function buildCriterionModule(body: string): string {
  return [CRITERION_PREAMBLE, "", body, "", 'console.log("PASS");'].join("\n");
}
