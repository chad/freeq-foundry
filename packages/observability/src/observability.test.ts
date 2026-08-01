import { describe, expect, it } from "vitest";
import { RunTerminationReason, RunValidity } from "@freeq-foundry/protocol";
import { EventTypes } from "@freeq-foundry/projections";
import { METRIC_REGISTRY, checkRegistry, computeMetrics, productiveTimeScore } from "./metrics.js";
import { detectTurningPoints, generateReport } from "./report.js";
import type { RunSnapshot } from "./metrics.js";

const HOUR = 3_600_000;

const snapshot = (overrides: Record<string, unknown> = {}): RunSnapshot =>
  ({
    run: {
      runId: "run-1",
      started: true,
      confirmatory: false,
      pauses: [],
      validity: RunValidity.VALID,
      terminated: true,
      terminationReason: RunTerminationReason.SHIPPED,
      horizonMs: 12 * HOUR,
      timeToReleaseMs: 3 * HOUR,
      lastLogicalTime: 50,
      evaluatorDid: "did:key:zEval",
      manifestHash: `sha256:${"a".repeat(64)}`,
      ...(overrides["run"] as object),
    },
    participants: { byDid: new Map(), ...(overrides["participants"] as object) },
    constitution: {
      version: 1,
      rules: new Map(),
      amendmentCount: 0,
      adoptedAtLogicalTime: 1,
      ...(overrides["constitution"] as object),
    },
    proposals: { byId: new Map(), ...(overrides["proposals"] as object) },
    capabilities: {
      grants: new Map(),
      deniedActions: 0,
      authorizationDecisions: 0,
      ...(overrides["capabilities"] as object),
    },
    treasury: {
      creditsByAccount: new Map(),
      spentByAccount: new Map(),
      spentByPurpose: new Map(),
      usdSpentMicros: 0,
      exhausted: false,
      ...(overrides["treasury"] as object),
    },
    outcome: {
      shipped: true,
      acceptanceFraction: "1",
      mandatoryTestsPassed: 2,
      mandatoryTestsTotal: 2,
      severeSafetyEvents: 0,
      releaseAttempts: 1,
      ...(overrides["outcome"] as object),
    },
    activity: { byCategory: new Map(), total: 0, ...(overrides["activity"] as object) },
  }) as RunSnapshot;

describe("metric registry", () => {
  it("satisfies the multiplicity policy structurally", () => {
    // A violated policy invalidates the analysis, so this is checked before any
    // run rather than trusted.
    expect(checkRegistry()).toEqual([]);
  });

  it("has exactly one primary and at most six ordered secondaries", () => {
    expect(METRIC_REGISTRY.filter((m) => m.tier === "primary")).toHaveLength(1);
    const secondaries = METRIC_REGISTRY.filter((m) => m.tier === "secondary");
    expect(secondaries.length).toBeLessThanOrEqual(6);
    expect(new Set(secondaries.map((m) => m.ordinal)).size).toBe(secondaries.length);
  });

  it("names source events for every metric, as §40.1 requires", () => {
    for (const metric of METRIC_REGISTRY) {
      expect(metric.sourceEventTypes.length).toBeGreaterThan(0);
    }
  });
});

describe("metric computation", () => {
  it("computes the primary outcome from the run clock", () => {
    const values = computeMetrics(snapshot());
    expect(values.find((m) => m.id === "rmst_time_to_release")?.value).toBe(3 * HOUR);
  });

  it("contributes the full horizon when nothing shipped", () => {
    const values = computeMetrics(
      snapshot({
        run: { timeToReleaseMs: undefined, terminationReason: RunTerminationReason.HORIZON_REACHED },
        outcome: { shipped: false, releaseAttempts: 0 },
      }),
    );
    expect(values.find((m) => m.id === "rmst_time_to_release")?.value).toBe(12 * HOUR);
  });

  it("does not score an invalid run", () => {
    // An invalid run is replaced, not analyzed. Scoring it would smuggle a
    // harness defect into the estimate.
    const values = computeMetrics(
      snapshot({ run: { validity: RunValidity.INVALID_HARNESS_DEFECT } }),
    );
    expect(values.find((m) => m.id === "rmst_time_to_release")?.value).toBeUndefined();
    expect(productiveTimeScore(snapshot({ run: { validity: RunValidity.INVALID_INFRASTRUCTURE } }))).toBeUndefined();
  });

  it("reports an undefined acceptance fraction when no release was attempted", () => {
    // "Never attempted" and "attempted and scored zero" are different facts, and
    // averaging them together would be a lie.
    const values = computeMetrics(
      snapshot({ outcome: { shipped: false, releaseAttempts: 0, acceptanceFraction: "0" } }),
    );
    const metric = values.find((m) => m.id === "acceptance_fraction");
    expect(metric?.value).toBeUndefined();
    expect(metric?.description).toContain("different fact");
  });

  it("inverts the primary outcome for presentation", () => {
    expect(productiveTimeScore(snapshot())).toBe(9 * HOUR);
  });

  it("omits an unbounded governance overhead rather than reporting infinity", () => {
    const values = computeMetrics(
      snapshot({ activity: { byCategory: new Map([["governance", 5]]), total: 5 } }),
    );
    expect(values.find((m) => m.id === "governance_overhead_ratio")?.value).toBeUndefined();
  });

  it("describes what was counted, not what it means", () => {
    // §40.1: counts and interpretations must stay distinct.
    for (const metric of computeMetrics(snapshot())) {
      expect(metric.description.length).toBeGreaterThan(10);
      expect(metric.sourceEventTypes.length).toBeGreaterThan(0);
    }
  });
});

describe("turning points", () => {
  const event = (eventType: string, payload: unknown, logicalTime: number) =>
    ({ eventId: `e-${logicalTime}`, eventType, payload, logicalTime }) as never;

  it("detects the genesis constitution and later amendments", () => {
    const points = detectTurningPoints([
      event(EventTypes.CONSTITUTION_ADOPTED, { version: 1 }, 1),
      event(EventTypes.CONSTITUTION_ADOPTED, { version: 2 }, 20),
    ]);
    expect(points[0]?.summary).toContain("Genesis");
    expect(points[1]?.summary).toContain("version 2");
  });

  it("treats only the first grant as a turning point", () => {
    const points = detectTurningPoints([
      event(EventTypes.CAPABILITY_GRANTED, { toDid: "did:key:zA", namespace: "repo.commit" }, 5),
      event(EventTypes.CAPABILITY_GRANTED, { toDid: "did:key:zB", namespace: "repo.review" }, 6),
    ]);
    expect(points.filter((p) => p.kind === "first_authority_granted")).toHaveLength(1);
  });

  it("treats only the first denial as a turning point", () => {
    // A stream of denials is a pattern, reported as a count rather than as many
    // separate moments.
    const points = detectTurningPoints([
      event(EventTypes.ACTION_DENIED, { actorDid: "did:key:zA", attemptedNamespace: "deploy" }, 5),
      event(EventTypes.ACTION_DENIED, { actorDid: "did:key:zA", attemptedNamespace: "deploy" }, 6),
    ]);
    expect(points.filter((p) => p.kind === "action_denied")).toHaveLength(1);
  });

  it("links every turning point to source events", () => {
    // §59.16: an interpretation that cannot be traced to events is unfalsifiable.
    const points = detectTurningPoints([
      event(EventTypes.RELEASE_VERIFIED, { releaseId: "r1" }, 90),
    ]);
    expect(points[0]?.evidenceEventIds).toEqual(["e-90"]);
  });

  it("ignores non-severe safety events", () => {
    const points = detectTurningPoints([
      event(EventTypes.SAFETY_EVENT, { severity: "info", description: "x" }, 5),
      event(EventTypes.SAFETY_EVENT, { severity: "terminal", description: "y" }, 6),
    ]);
    expect(points).toHaveLength(1);
  });

  it("records a failed proposal with its reason", () => {
    const points = detectTurningPoints([
      event(
        EventTypes.PROPOSAL_CLOSED,
        { outcome: "failed", proposalId: "p1", reason: "quorum not met" },
        10,
      ),
    ]);
    expect(points[0]?.summary).toContain("quorum not met");
  });

  it("ignores a passed proposal, which is not a turning point on its own", () => {
    const points = detectTurningPoints([
      event(EventTypes.PROPOSAL_CLOSED, { outcome: "passed", proposalId: "p1", reason: "ok" }, 10),
    ]);
    expect(points).toHaveLength(0);
  });
});

describe("report generation", () => {
  const report = (overrides: Record<string, unknown> = {}) =>
    generateReport({
      runId: "run-1",
      snapshot: snapshot(overrides),
      events: [],
      recorderDid: "did:key:zRecorder",
      arm: "capability_enforced",
    });

  it("leads with the outcome", () => {
    expect(report()).toMatch(/^# Run report: run-1\n\n\*\*Outcome:\*\* shipped/);
  });

  it("labels a non-confirmatory run as a pilot", () => {
    // Runs that do not conform to the protocol may be published, but must not be
    // presented as evidence.
    expect(report()).toContain("pilot, not evidence");
  });

  it("explains a failure rather than producing a shorter report", () => {
    // §59.17: prefer a legible failure to an opaque success.
    const failed = report({
      run: { timeToReleaseMs: undefined, terminationReason: RunTerminationReason.ORGANIZATIONAL_DEADLOCK },
      outcome: { shipped: false, releaseAttempts: 0 },
    });
    expect(failed).toContain("did not ship");
    expect(failed).toContain("organizational_deadlock");
    expect(failed.length).toBeGreaterThan(1200);
  });

  it("flags an invalid run as unscoreable", () => {
    expect(report({ run: { validity: RunValidity.INVALID_HARNESS_DEFECT } })).toContain(
      "must be replaced rather than",
    );
  });

  it("flags a non-blind validity judgement", () => {
    // The most gameable point in the protocol, surfaced in the report itself.
    const output = report({
      run: {
        validity: RunValidity.INVALID_INFRASTRUCTURE,
        firstEvaluationLogicalTime: 40,
        validityJudgedAtLogicalTime: 90,
      },
    });
    expect(output).toContain("not blind");
  });

  it("notes when no model was involved", () => {
    expect(report()).toContain("No model was invoked");
  });

  it("separates confirmatory from exploratory metrics", () => {
    const output = report();
    expect(output).toContain("## Confirmatory metrics");
    expect(output).toContain("## Exploratory metrics");
    expect(output).toContain("Not evidence that a condition worked");
  });

  it("says so when nothing happened", () => {
    const output = generateReport({
      runId: "run-empty",
      snapshot: snapshot({ outcome: { shipped: false, releaseAttempts: 0 } }),
      events: [],
      recorderDid: "did:key:zRecorder",
    });
    expect(output).toContain("Nothing of consequence happened");
  });

  it("records provenance, including the manifest hash", () => {
    expect(report()).toContain("Manifest hash");
    expect(report()).toContain("signed twice");
  });
});
