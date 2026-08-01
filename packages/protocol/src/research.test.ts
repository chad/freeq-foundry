import { describe, expect, it } from "vitest";
import {
  CONFIRMATORY_MIN_VERIFICATION_LEVEL,
  DEFAULT_HORIZON_MS,
  ModelVerificationLevel,
  RunTerminationReason,
  RunValidity,
  checkValidityBlindness,
  impliedValidity,
  isConfirmatoryGrade,
  isOrganizationalFailure,
  isSnapshotSubstituted,
  productiveTimeMs,
  restrictedTimeMs,
  runClockMs,
  validateMetricRegistry,
  type MetricDefinition,
  type ModelSnapshotPin,
  type RunOutcome,
} from "./research.js";

const HOUR = 60 * 60 * 1000;
const GENESIS = Date.UTC(2026, 0, 1, 0, 0, 0);

describe("run clock", () => {
  it("is wall-clock elapsed time when nothing paused", () => {
    expect(runClockMs(GENESIS, GENESIS + 3 * HOUR, [])).toBe(3 * HOUR);
  });

  it("excludes closed pauses", () => {
    const pauses = [
      { pausedAtMs: GENESIS + 1 * HOUR, resumedAtMs: GENESIS + 2 * HOUR },
    ];
    expect(runClockMs(GENESIS, GENESIS + 4 * HOUR, pauses)).toBe(3 * HOUR);
  });

  it("excludes multiple pauses", () => {
    const pauses = [
      { pausedAtMs: GENESIS + 1 * HOUR, resumedAtMs: GENESIS + 2 * HOUR },
      { pausedAtMs: GENESIS + 5 * HOUR, resumedAtMs: GENESIS + 6 * HOUR },
    ];
    expect(runClockMs(GENESIS, GENESIS + 8 * HOUR, pauses)).toBe(6 * HOUR);
  });

  it("treats an unresolved pause as still open, never crediting unworked time", () => {
    const pauses = [{ pausedAtMs: GENESIS + 2 * HOUR }];
    expect(runClockMs(GENESIS, GENESIS + 5 * HOUR, pauses)).toBe(2 * HOUR);
  });

  it("ignores pauses that start after the measurement point", () => {
    const pauses = [
      { pausedAtMs: GENESIS + 6 * HOUR, resumedAtMs: GENESIS + 7 * HOUR },
    ];
    expect(runClockMs(GENESIS, GENESIS + 3 * HOUR, pauses)).toBe(3 * HOUR);
  });

  it("clips a pause that overruns the measurement point", () => {
    const pauses = [
      { pausedAtMs: GENESIS + 2 * HOUR, resumedAtMs: GENESIS + 9 * HOUR },
    ];
    expect(runClockMs(GENESIS, GENESIS + 4 * HOUR, pauses)).toBe(2 * HOUR);
  });

  it("is deterministic, so two analysts cannot get two answers", () => {
    const pauses = [
      { pausedAtMs: GENESIS + 1 * HOUR, resumedAtMs: GENESIS + 2 * HOUR },
    ];
    const a = runClockMs(GENESIS, GENESIS + 5 * HOUR, pauses);
    const b = runClockMs(GENESIS, GENESIS + 5 * HOUR, [...pauses]);
    expect(a).toBe(b);
  });

  it("rejects a measurement before genesis", () => {
    expect(() => runClockMs(GENESIS, GENESIS - 1, [])).toThrow(RangeError);
  });
});

describe("primary outcome", () => {
  const base = { runId: "r1", horizonMs: DEFAULT_HORIZON_MS } as const;

  it("uses time to release when a run shipped", () => {
    const outcome: RunOutcome = {
      ...base,
      validity: RunValidity.VALID,
      terminationReason: RunTerminationReason.SHIPPED,
      timeToReleaseMs: 3 * HOUR,
    };
    expect(restrictedTimeMs(outcome)).toBe(3 * HOUR);
    expect(productiveTimeMs(outcome)).toBe(9 * HOUR);
  });

  it("contributes the full horizon when a run did not ship", () => {
    const outcome: RunOutcome = {
      ...base,
      validity: RunValidity.VALID,
      terminationReason: RunTerminationReason.HORIZON_REACHED,
    };
    expect(restrictedTimeMs(outcome)).toBe(DEFAULT_HORIZON_MS);
    expect(productiveTimeMs(outcome)).toBe(0);
  });

  it("clips a release that somehow lands past the horizon", () => {
    const outcome: RunOutcome = {
      ...base,
      validity: RunValidity.VALID,
      terminationReason: RunTerminationReason.SHIPPED,
      timeToReleaseMs: 15 * HOUR,
    };
    expect(restrictedTimeMs(outcome)).toBe(DEFAULT_HORIZON_MS);
  });

  it("reproduces the ruling's worked examples", () => {
    const score = (hours?: number) =>
      productiveTimeMs({
        ...base,
        validity: RunValidity.VALID,
        terminationReason:
          hours === undefined
            ? RunTerminationReason.HORIZON_REACHED
            : RunTerminationReason.SHIPPED,
        ...(hours === undefined ? {} : { timeToReleaseMs: hours * HOUR }),
      }) / HOUR;

    expect(score(3)).toBe(9);
    expect(score(9)).toBe(3);
    expect(score(undefined)).toBe(0);
  });

  it("refuses to score an invalid run", () => {
    // An invalid run is replaced, not analyzed. Scoring it would smuggle a
    // harness defect into the estimate.
    expect(() =>
      restrictedTimeMs({
        ...base,
        validity: RunValidity.INVALID_HARNESS_DEFECT,
        terminationReason: RunTerminationReason.HARNESS_DEFECT,
      }),
    ).toThrow(/must be replaced, not scored/);
  });
});

describe("termination classification", () => {
  it("counts organizational failure as no-success, not censoring", () => {
    // The runs where the institution failed are the outcome under study.
    // Treating them as censored would quietly discard them.
    for (const reason of [
      RunTerminationReason.HORIZON_REACHED,
      RunTerminationReason.ORGANIZATIONAL_DEADLOCK,
      RunTerminationReason.BUDGET_EXHAUSTED,
      RunTerminationReason.SAFETY_TERMINATION,
      RunTerminationReason.CONTROLLER_INTERVENTION,
    ] as const) {
      expect(isOrganizationalFailure(reason)).toBe(true);
      expect(impliedValidity(reason)).toBe(RunValidity.VALID);
    }
  });

  it("does not count shipping as failure", () => {
    expect(isOrganizationalFailure(RunTerminationReason.SHIPPED)).toBe(false);
  });

  it("invalidates only platform-side failures", () => {
    expect(impliedValidity(RunTerminationReason.HARNESS_DEFECT)).toBe(
      RunValidity.INVALID_HARNESS_DEFECT,
    );
    expect(impliedValidity(RunTerminationReason.INFRASTRUCTURE_OUTAGE)).toBe(
      RunValidity.INVALID_INFRASTRUCTURE,
    );
    expect(isOrganizationalFailure(RunTerminationReason.HARNESS_DEFECT)).toBe(false);
  });
});

describe("validity blindness", () => {
  it("accepts an invalidation decided before evaluation", () => {
    expect(
      checkValidityBlindness([
        {
          runId: "r1",
          validity: RunValidity.INVALID_HARNESS_DEFECT,
          judgementLogicalTime: 40,
          firstEvaluationLogicalTime: 90,
        },
      ]),
    ).toEqual([]);
  });

  it("rejects an invalidation decided after evaluation began", () => {
    // The most gameable point in the whole protocol: deciding a run was invalid
    // after seeing it produced an inconvenient result.
    const problems = checkValidityBlindness([
      {
        runId: "r7",
        validity: RunValidity.INVALID_INFRASTRUCTURE,
        judgementLogicalTime: 120,
        firstEvaluationLogicalTime: 90,
      },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("was not blind");
  });

  it("ignores runs that were never invalidated", () => {
    expect(
      checkValidityBlindness([
        {
          runId: "r2",
          validity: RunValidity.VALID,
          judgementLogicalTime: 500,
          firstEvaluationLogicalTime: 90,
        },
      ]),
    ).toEqual([]);
  });

  it("accepts an invalidation for a run that never reached evaluation", () => {
    expect(
      checkValidityBlindness([
        {
          runId: "r3",
          validity: RunValidity.INVALID_HARNESS_DEFECT,
          judgementLogicalTime: 12,
        },
      ]),
    ).toEqual([]);
  });
});

describe("model verification levels", () => {
  it("orders evidence from unreported to platform-mediated", () => {
    expect(ModelVerificationLevel.UNREPORTED).toBeLessThan(
      ModelVerificationLevel.SELF_REPORTED,
    );
    expect(ModelVerificationLevel.SELF_REPORTED).toBeLessThan(
      ModelVerificationLevel.RUNTIME_ATTESTED,
    );
    expect(ModelVerificationLevel.PROVIDER_RECEIPT).toBeLessThan(
      ModelVerificationLevel.PLATFORM_MEDIATED,
    );
  });

  it("excludes self-report from confirmatory use", () => {
    // Condition assignment must never depend on a Level 0-1 claim.
    expect(isConfirmatoryGrade(ModelVerificationLevel.UNREPORTED)).toBe(false);
    expect(isConfirmatoryGrade(ModelVerificationLevel.SELF_REPORTED)).toBe(false);
    expect(isConfirmatoryGrade(ModelVerificationLevel.RUNTIME_ATTESTED)).toBe(true);
    expect(isConfirmatoryGrade(ModelVerificationLevel.PLATFORM_MEDIATED)).toBe(true);
    expect(CONFIRMATORY_MIN_VERIFICATION_LEVEL).toBe(
      ModelVerificationLevel.RUNTIME_ATTESTED,
    );
  });
});

describe("snapshot substitution", () => {
  const pin: ModelSnapshotPin = {
    provider: "anthropic",
    modelIdentifier: "claude-sonnet-4-5",
    snapshotIdentifier: "claude-sonnet-4-5-20250929",
    apiVersion: "2023-06-01",
    systemPromptHash: `sha256:${"a".repeat(64)}`,
    toolSchemaHash: `sha256:${"b".repeat(64)}`,
    invokedAt: "2026-01-01T00:00:00.000Z",
    verificationLevel: ModelVerificationLevel.PLATFORM_MEDIATED,
  };

  it("detects a provider returning a different snapshot", () => {
    // Recording what we asked for proves intent; recording what came back
    // detects silent endpoint substitution.
    expect(
      isSnapshotSubstituted({
        ...pin,
        returnedModelIdentifier: "claude-sonnet-4-5-20260115",
      }),
    ).toBe(true);
  });

  it("accepts a matching snapshot identifier", () => {
    expect(
      isSnapshotSubstituted({
        ...pin,
        returnedModelIdentifier: "claude-sonnet-4-5-20250929",
      }),
    ).toBe(false);
  });

  it("accepts a return of the unversioned model identifier", () => {
    expect(
      isSnapshotSubstituted({ ...pin, returnedModelIdentifier: "claude-sonnet-4-5" }),
    ).toBe(false);
  });

  it("cannot conclude anything when nothing was returned", () => {
    expect(isSnapshotSubstituted(pin)).toBe(false);
  });
});

describe("metric registry", () => {
  const metric = (
    id: string,
    tier: MetricDefinition["tier"],
    ordinal?: number,
  ): MetricDefinition => ({
    id,
    version: 1,
    tier,
    ...(ordinal === undefined ? {} : { ordinal }),
    sourceEventTypes: ["evaluation.release_verified"],
    higherIsBetter: false,
  });

  it("accepts a conforming registry", () => {
    expect(
      validateMetricRegistry([
        metric("rmst_time_to_release", "primary"),
        metric("shipped_by_horizon", "secondary", 1),
        metric("acceptance_fraction", "secondary", 2),
        metric("total_model_cost", "secondary", 3),
        metric("governance_cost_share", "secondary", 4),
        metric("authority_concentration", "secondary", 5),
        metric("safety_events", "secondary", 6),
        metric("proposal_throughput", "exploratory"),
      ]),
    ).toEqual([]);
  });

  it("requires exactly one primary", () => {
    expect(validateMetricRegistry([metric("a", "exploratory")])).toContain(
      "exactly one primary metric is permitted, found 0",
    );
    expect(
      validateMetricRegistry([metric("a", "primary"), metric("b", "primary")]),
    ).toContain("exactly one primary metric is permitted, found 2");
  });

  it("caps secondaries at six", () => {
    const metrics = [
      metric("p", "primary"),
      ...Array.from({ length: 7 }, (_, i) => metric(`s${i}`, "secondary", i + 1)),
    ];
    expect(validateMetricRegistry(metrics)).toContain(
      "at most 6 secondary metrics are permitted, found 7",
    );
  });

  it("requires a gatekeeping ordinal on every secondary", () => {
    expect(
      validateMetricRegistry([metric("p", "primary"), metric("s", "secondary")]),
    ).toContain("secondary metric s has no gatekeeping ordinal");
  });

  it("rejects duplicate ordinals, which would make the sequence ambiguous", () => {
    expect(
      validateMetricRegistry([
        metric("p", "primary"),
        metric("s1", "secondary", 1),
        metric("s2", "secondary", 1),
      ]),
    ).toContain("duplicate gatekeeping ordinal 1");
  });

  it("rejects an ordinal on a non-secondary", () => {
    expect(
      validateMetricRegistry([metric("p", "primary", 1)]),
    ).toContain("primary metric p must not have a gatekeeping ordinal");
  });

  it("requires every metric to identify its source events", () => {
    expect(
      validateMetricRegistry([
        { ...metric("p", "primary"), sourceEventTypes: [] },
      ]),
    ).toContain("metric p identifies no source event types");
  });

  it("rejects duplicate metric ids", () => {
    expect(
      validateMetricRegistry([metric("p", "primary"), metric("p", "exploratory")]),
    ).toContain("duplicate metric id p");
  });
});
