/**
 * Types required by the research protocol.
 *
 * These exist because a protocol is only real if the harness can produce the
 * data it requires. Every field here traces to a specific requirement in
 * docs/research-protocol.md; none is speculative.
 *
 * Spec: §32.6, §40.1, §49, §53, §58.6, §58.13. Decision: ADR-0009.
 */
import type { Digest } from "./hash.js";

/**
 * Evidence for a claim about which model produced an action.
 *
 * Replaces a binary claimed/verified distinction with graded evidence. The
 * operative constraint (research protocol §8): experimental condition assignment
 * MUST NOT depend on a Level 0–1 claim, and model-family analyses involving
 * unverified identities are exploratory only.
 *
 * In practice externally operated agents are Level 1 today: nothing above it
 * exists yet for them. Saying so explicitly is better than implying otherwise.
 */
export const ModelVerificationLevel = {
  /** No model identity reported. */
  UNREPORTED: 0,
  /** Operator says so. A claim, not a fact. */
  SELF_REPORTED: 1,
  /** Signed attestation from the agent runtime. */
  RUNTIME_ATTESTED: 2,
  /** Provider receipt or verifiable invocation metadata. */
  PROVIDER_RECEIPT: 3,
  /** Platform-mediated invocation against a pinned snapshot. */
  PLATFORM_MEDIATED: 4,
} as const;

export type ModelVerificationLevel =
  (typeof ModelVerificationLevel)[keyof typeof ModelVerificationLevel];

/** Levels at which model identity may inform a confirmatory claim. */
export const CONFIRMATORY_MIN_VERIFICATION_LEVEL: ModelVerificationLevel =
  ModelVerificationLevel.RUNTIME_ATTESTED;

export function isConfirmatoryGrade(level: ModelVerificationLevel): boolean {
  return level >= CONFIRMATORY_MIN_VERIFICATION_LEVEL;
}

/**
 * Exactly what was invoked, pinned.
 *
 * `returnedModelIdentifier` is the field most easily skipped and the most
 * important: recording what we *asked for* proves intent, while recording what
 * *came back* detects silent endpoint substitution — the drift the protocol is
 * defending against. A mismatch is a finding, not a warning to suppress.
 */
export interface ModelSnapshotPin {
  readonly provider: string;
  readonly modelIdentifier: string;
  readonly snapshotIdentifier: string;
  readonly apiVersion: string;
  readonly systemPromptHash: Digest;
  readonly toolSchemaHash: Digest;
  /** Decimal string, per ADR-0004: no floats in canonical payloads. */
  readonly temperature?: string;
  readonly reasoningParameters?: Readonly<Record<string, string>>;
  /** The identifier the provider actually returned. */
  readonly returnedModelIdentifier?: string;
  readonly invokedAt: string;
  readonly verificationLevel: ModelVerificationLevel;
}

/** True when the provider returned something other than what was requested. */
export function isSnapshotSubstituted(pin: ModelSnapshotPin): boolean {
  return (
    pin.returnedModelIdentifier !== undefined &&
    pin.returnedModelIdentifier !== pin.snapshotIdentifier &&
    pin.returnedModelIdentifier !== pin.modelIdentifier
  );
}

/**
 * The five versions whose combination defines an exchangeable study epoch.
 *
 * Confirmatory estimates are made within one epoch. Cross-epoch results may be
 * combined with an epoch-level random effect, but are not perfectly exchangeable
 * replications.
 */
export interface EpochDescriptor {
  readonly scenarioVersion: string;
  readonly harnessVersion: string;
  readonly promptSetVersion: string;
  readonly modelRosterVersion: string;
  readonly evaluatorVersion: string;
}

/** Position of a run within the matched-block design. */
export interface BlockAssignment {
  readonly blockId: string;
  /** Condition label, e.g. "capability_enforced" or "unenforced_governance". */
  readonly arm: string;
  /** Shared across every run in the block: scenario seed, information allocation, roster. */
  readonly blockSeed: string;
  /** 1-based execution order within the block. Randomized. */
  readonly executionOrder: number;
}

/**
 * Whether a run counts as evidence, independent of how it turned out.
 *
 * Deliberately separate from outcome. Conflating them would let a bad result be
 * reclassified as a bug.
 */
export const RunValidity = {
  VALID: "valid",
  /** Harness defect made the run uninterpretable. Replace. */
  INVALID_HARNESS_DEFECT: "invalid_harness_defect",
  /** Infrastructure outage unrelated to participants or condition. Replace. */
  INVALID_INFRASTRUCTURE: "invalid_infrastructure",
} as const;

export type RunValidity = (typeof RunValidity)[keyof typeof RunValidity];

/**
 * Why a run ended.
 *
 * Note which of these are *organizational failures* and therefore count as
 * "did not ship" rather than as independent censoring. Treating deadlock or
 * budget exhaustion as censoring would quietly discard the runs where the
 * institution failed, which is exactly the outcome under study.
 */
export const RunTerminationReason = {
  SHIPPED: "shipped",
  HORIZON_REACHED: "horizon_reached",
  ORGANIZATIONAL_DEADLOCK: "organizational_deadlock",
  BUDGET_EXHAUSTED: "budget_exhausted",
  SAFETY_TERMINATION: "safety_termination",
  CONTROLLER_INTERVENTION: "controller_intervention",
  HARNESS_DEFECT: "harness_defect",
  INFRASTRUCTURE_OUTAGE: "infrastructure_outage",
} as const;

export type RunTerminationReason =
  (typeof RunTerminationReason)[keyof typeof RunTerminationReason];

/** Reasons that are the organization's own failure, not external censoring. */
const ORGANIZATIONAL_FAILURES: ReadonlySet<string> = new Set([
  RunTerminationReason.HORIZON_REACHED,
  RunTerminationReason.ORGANIZATIONAL_DEADLOCK,
  RunTerminationReason.BUDGET_EXHAUSTED,
  RunTerminationReason.SAFETY_TERMINATION,
  RunTerminationReason.CONTROLLER_INTERVENTION,
]);

export function isOrganizationalFailure(reason: RunTerminationReason): boolean {
  return ORGANIZATIONAL_FAILURES.has(reason);
}

/** Reasons that invalidate a run rather than scoring it. */
export function impliedValidity(reason: RunTerminationReason): RunValidity {
  switch (reason) {
    case RunTerminationReason.HARNESS_DEFECT:
      return RunValidity.INVALID_HARNESS_DEFECT;
    case RunTerminationReason.INFRASTRUCTURE_OUTAGE:
      return RunValidity.INVALID_INFRASTRUCTURE;
    default:
      return RunValidity.VALID;
  }
}

/**
 * Everything pinned for a run, hashed and signed by the controller and emitted
 * as the genesis event payload.
 *
 * Putting the experimental design inside the tamper-evident record — rather than
 * beside it in a spreadsheet — is what makes a run's membership in the
 * confirmatory set mechanically checkable.
 */
export interface RunManifest {
  readonly runId: string;
  readonly epoch: EpochDescriptor;
  readonly block?: BlockAssignment;
  /** DID whose key attests event position for this run (ADR-0008). */
  readonly recorderDid: string;
  /** DID whose signature makes a release outcome official. */
  readonly evaluatorDid: string;
  /** Outcome horizon τ in milliseconds. 12 hours for the initial protocol. */
  readonly horizonMs: number;
  /** Hash of the pre-registration statement in force, if this is a confirmatory run. */
  readonly preRegistrationHash?: Digest;
  /**
   * False for exploratory or debugging runs.
   *
   * A pilot may use a relaxed manifest. It must not be presented as evidence.
   */
  readonly confirmatory: boolean;
}

/** τ for the initial protocol: 12 hours. */
export const DEFAULT_HORIZON_MS = 12 * 60 * 60 * 1000;

/** A closed interval during which the run clock was stopped. */
export interface ClockPause {
  readonly pausedAtMs: number;
  /** Absent while a pause is still open. */
  readonly resumedAtMs?: number;
}

/**
 * Elapsed run time: wall time since genesis, net of permitted pauses.
 *
 * A third temporal notion, beyond `logicalTime` (canonical append position) and
 * `wallTime` (timestamp). Neither of those answers "how long has this
 * organization been working?" once infrastructure outages may stop the clock.
 *
 * Derived from pause events rather than stored, so replay reconstructs it
 * exactly (§6.9) and two analysts cannot get two answers.
 */
export function runClockMs(
  genesisWallTimeMs: number,
  atWallTimeMs: number,
  pauses: readonly ClockPause[],
): number {
  if (atWallTimeMs < genesisWallTimeMs) {
    throw new RangeError(
      `wall time ${atWallTimeMs} precedes genesis ${genesisWallTimeMs}`,
    );
  }
  let paused = 0;
  for (const pause of pauses) {
    if (pause.pausedAtMs >= atWallTimeMs) continue;
    // An unresolved pause is treated as still open at the point of measurement,
    // which is the conservative reading: it never credits time that may not
    // have been worked.
    const end = Math.min(pause.resumedAtMs ?? atWallTimeMs, atWallTimeMs);
    paused += Math.max(0, end - Math.max(pause.pausedAtMs, genesisWallTimeMs));
  }
  return Math.max(0, atWallTimeMs - genesisWallTimeMs - paused);
}

/** The run-level result feeding the primary outcome. */
export interface RunOutcome {
  readonly runId: string;
  readonly validity: RunValidity;
  readonly terminationReason: RunTerminationReason;
  /** Run-clock milliseconds to evaluator-verified release, absent if it never shipped. */
  readonly timeToReleaseMs?: number;
  readonly horizonMs: number;
}

/**
 * Restricted time to release: min(T, τ), with non-shipping runs contributing τ.
 *
 * The per-run input to ΔRMST. Lower is better.
 */
export function restrictedTimeMs(outcome: RunOutcome): number {
  if (outcome.validity !== RunValidity.VALID) {
    throw new Error(
      `run ${outcome.runId} is ${outcome.validity} and must be replaced, not scored`,
    );
  }
  if (outcome.timeToReleaseMs === undefined) return outcome.horizonMs;
  return Math.min(outcome.timeToReleaseMs, outcome.horizonMs);
}

/** The inverted presentation form: higher is better. */
export function productiveTimeMs(outcome: RunOutcome): number {
  return outcome.horizonMs - restrictedTimeMs(outcome);
}

/**
 * Confirmatory status of a metric.
 *
 * Exactly one metric may be `primary`; at most six may be `secondary`, with
 * distinct ordinals defining the gatekeeping sequence. Enforced by
 * {@link validateMetricRegistry} so the multiplicity policy cannot erode by
 * someone quietly promoting a metric.
 */
export type MetricTier = "primary" | "secondary" | "exploratory";

export interface MetricDefinition {
  readonly id: string;
  readonly version: number;
  readonly tier: MetricTier;
  /** Gatekeeping position, 1-based. Required for and unique among secondaries. */
  readonly ordinal?: number;
  /** Event types this metric is computed from (§40.1). */
  readonly sourceEventTypes: readonly string[];
  /** Whether a higher value is better. Ambiguity here produces sign errors. */
  readonly higherIsBetter: boolean;
}

export const MAX_SECONDARY_METRICS = 6;

/** Structural violations of the multiplicity policy. */
export function validateMetricRegistry(
  metrics: readonly MetricDefinition[],
): string[] {
  const problems: string[] = [];

  const primaries = metrics.filter((m) => m.tier === "primary");
  if (primaries.length !== 1) {
    problems.push(
      `exactly one primary metric is permitted, found ${primaries.length}`,
    );
  }

  const secondaries = metrics.filter((m) => m.tier === "secondary");
  if (secondaries.length > MAX_SECONDARY_METRICS) {
    problems.push(
      `at most ${MAX_SECONDARY_METRICS} secondary metrics are permitted, found ${secondaries.length}`,
    );
  }

  const ordinals = new Set<number>();
  for (const metric of secondaries) {
    if (metric.ordinal === undefined) {
      problems.push(`secondary metric ${metric.id} has no gatekeeping ordinal`);
      continue;
    }
    if (ordinals.has(metric.ordinal)) {
      problems.push(`duplicate gatekeeping ordinal ${metric.ordinal}`);
    }
    ordinals.add(metric.ordinal);
  }

  for (const metric of metrics) {
    if (metric.tier !== "secondary" && metric.ordinal !== undefined) {
      problems.push(
        `${metric.tier} metric ${metric.id} must not have a gatekeeping ordinal`,
      );
    }
    if (metric.sourceEventTypes.length === 0) {
      problems.push(`metric ${metric.id} identifies no source event types`);
    }
  }

  const ids = metrics.map((m) => m.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  for (const id of new Set(duplicates)) {
    problems.push(`duplicate metric id ${id}`);
  }

  return problems;
}

/**
 * Reject a confirmatory dataset whose validity judgements postdate outcome
 * inspection.
 *
 * The single most gameable point in the protocol is deciding a run was invalid
 * after seeing that it produced an inconvenient result. The ruling requires
 * blindness; this makes it a property of event ordering rather than of trust,
 * which is the kind of thing the platform is already built to prove (§6.8).
 */
export function checkValidityBlindness(judgements: readonly {
  readonly runId: string;
  readonly validity: RunValidity;
  readonly judgementLogicalTime: number;
  /** Logical time of the first evaluation event for the run, if any. */
  readonly firstEvaluationLogicalTime?: number;
}[]): string[] {
  const problems: string[] = [];
  for (const judgement of judgements) {
    if (judgement.validity === RunValidity.VALID) continue;
    const evaluated = judgement.firstEvaluationLogicalTime;
    if (evaluated === undefined) continue;
    if (judgement.judgementLogicalTime > evaluated) {
      problems.push(
        `run ${judgement.runId} was invalidated at logical time ` +
          `${judgement.judgementLogicalTime}, after evaluation began at ${evaluated}; ` +
          `the replacement decision was not blind`,
      );
    }
  }
  return problems;
}
