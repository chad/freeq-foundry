/**
 * The metric registry and computation.
 *
 * §40.1 requires metrics to have versioned definitions, identify their source
 * events, distinguish counts from interpretations, and avoid treating activity as
 * contribution or formal power as legitimate influence.
 *
 * The research protocol adds confirmatory tiers: exactly one primary, at most six
 * gatekept secondaries, everything else exploratory. `validateMetricRegistry`
 * enforces that structurally, so the multiplicity policy cannot erode by someone
 * quietly promoting a metric.
 *
 * Spec: §40. Decision: ADR-0009.
 */
import {
  RunValidity,
  productiveTimeMs,
  restrictedTimeMs,
  validateMetricRegistry,
  type MetricDefinition,
  type RunOutcome,
} from "@freeq-foundry/protocol";
import {
  EventTypes,
  authorityConcentration,
  autonomyDisagreements,
  distinctLineages,
  governanceCostShare,
  governanceOverhead,
  type ActivityState,
  type CapabilitiesState,
  type ConstitutionState,
  type OutcomeState,
  type ParticipantsState,
  type ProposalsState,
  type RunState,
  type TreasuryState,
} from "@freeq-foundry/projections";

export interface RunSnapshot {
  readonly run: RunState;
  readonly participants: ParticipantsState;
  readonly constitution: ConstitutionState;
  readonly proposals: ProposalsState;
  readonly capabilities: CapabilitiesState;
  readonly treasury: TreasuryState;
  readonly outcome: OutcomeState;
  readonly activity: ActivityState;
}

/**
 * The registry.
 *
 * The primary and the six secondaries are fixed by the research protocol. Adding
 * an exploratory metric is free; promoting one is a protocol amendment.
 */
export const METRIC_REGISTRY: readonly MetricDefinition[] = [
  {
    id: "rmst_time_to_release",
    version: 1,
    tier: "primary",
    sourceEventTypes: [
      EventTypes.RUN_STARTED,
      EventTypes.RELEASE_VERIFIED,
      EventTypes.RUN_CLOCK_PAUSED,
      EventTypes.RUN_CLOCK_RESUMED,
    ],
    higherIsBetter: false,
  },
  {
    id: "shipped_by_horizon",
    version: 1,
    tier: "secondary",
    ordinal: 1,
    sourceEventTypes: [EventTypes.RELEASE_VERIFIED],
    higherIsBetter: true,
  },
  {
    id: "acceptance_fraction",
    version: 1,
    tier: "secondary",
    ordinal: 2,
    sourceEventTypes: [EventTypes.RELEASE_VERIFIED, EventTypes.RELEASE_REJECTED],
    higherIsBetter: true,
  },
  {
    id: "total_model_cost_micros",
    version: 1,
    tier: "secondary",
    ordinal: 3,
    sourceEventTypes: [EventTypes.SPEND_RECORDED],
    higherIsBetter: false,
  },
  {
    id: "governance_cost_share_pct",
    version: 1,
    tier: "secondary",
    ordinal: 4,
    sourceEventTypes: [EventTypes.SPEND_RECORDED],
    higherIsBetter: false,
  },
  {
    id: "authority_concentration_pct",
    version: 1,
    tier: "secondary",
    ordinal: 5,
    sourceEventTypes: [
      EventTypes.CAPABILITY_GRANTED,
      EventTypes.CAPABILITY_REVOKED,
      EventTypes.PARTICIPANT_ADMITTED,
    ],
    higherIsBetter: false,
  },
  {
    id: "severe_safety_events",
    version: 1,
    tier: "secondary",
    ordinal: 6,
    sourceEventTypes: [EventTypes.SAFETY_EVENT],
    higherIsBetter: false,
  },

  // Exploratory. Reported with effect sizes and intervals; never used to claim a
  // condition worked.
  {
    id: "governance_overhead_ratio",
    version: 1,
    tier: "exploratory",
    sourceEventTypes: [EventTypes.PROPOSAL_OPENED, EventTypes.WORK_ITEM_COMPLETED],
    higherIsBetter: false,
  },
  {
    id: "time_to_constitution_ticks",
    version: 1,
    tier: "exploratory",
    sourceEventTypes: [EventTypes.CONSTITUTION_ADOPTED],
    higherIsBetter: false,
  },
  {
    id: "time_to_first_grant_ticks",
    version: 1,
    tier: "exploratory",
    sourceEventTypes: [EventTypes.CAPABILITY_GRANTED],
    higherIsBetter: false,
  },
  {
    id: "proposal_pass_rate_pct",
    version: 1,
    tier: "exploratory",
    sourceEventTypes: [EventTypes.PROPOSAL_CLOSED],
    higherIsBetter: true,
  },
  {
    id: "denied_actions",
    version: 1,
    tier: "exploratory",
    sourceEventTypes: [EventTypes.ACTION_DENIED],
    higherIsBetter: false,
  },
  {
    id: "distinct_lineages",
    version: 1,
    tier: "exploratory",
    sourceEventTypes: [EventTypes.PARTICIPANT_ADMITTED],
    higherIsBetter: true,
  },
  {
    id: "amendment_count",
    version: 1,
    tier: "exploratory",
    sourceEventTypes: [EventTypes.CONSTITUTION_ADOPTED],
    higherIsBetter: true,
  },
];

/** Registry problems, if any. Empty means the multiplicity policy holds. */
export function checkRegistry(): readonly string[] {
  return validateMetricRegistry(METRIC_REGISTRY);
}

export interface MetricValue {
  readonly id: string;
  readonly tier: MetricDefinition["tier"];
  readonly ordinal?: number;
  /** Numeric value, or undefined where the run produced no basis for one. */
  readonly value?: number;
  readonly unit: string;
  /** Plain-language statement of what was counted, not what it means (§40.1). */
  readonly description: string;
  /** Event types the value derives from, so a reader can check it. */
  readonly sourceEventTypes: readonly string[];
}

/**
 * Compute every registered metric.
 *
 * Returns counts, not interpretations. A metric that has no basis in the run
 * reports `undefined` rather than 0, because "no releases were attempted" and
 * "releases were attempted and all failed" are different facts and averaging them
 * together would be a lie.
 */
export function computeMetrics(snapshot: RunSnapshot): readonly MetricValue[] {
  const at = snapshot.run.lastLogicalTime;
  const horizonMs = snapshot.run.horizonMs ?? 0;

  const outcome: RunOutcome = {
    runId: snapshot.run.runId ?? "unknown",
    validity: snapshot.run.validity,
    terminationReason: snapshot.run.terminationReason ?? "horizon_reached",
    ...(snapshot.run.timeToReleaseMs === undefined
      ? {}
      : { timeToReleaseMs: snapshot.run.timeToReleaseMs }),
    horizonMs,
  };

  const closed = [...snapshot.proposals.byId.values()].filter(
    (p) => p.status === "passed" || p.status === "failed" || p.status === "executed",
  );
  const passed = closed.filter((p) => p.status === "passed" || p.status === "executed");

  const firstGrant = [...snapshot.capabilities.grants.values()].reduce<number | undefined>(
    (earliest, grant) =>
      earliest === undefined || grant.grantedAtLogicalTime < earliest
        ? grant.grantedAtLogicalTime
        : earliest,
    undefined,
  );

  const values: MetricValue[] = [
    {
      id: "rmst_time_to_release",
      tier: "primary",
      // Only scoreable for a valid run: an invalid run is replaced, not analyzed.
      ...(snapshot.run.validity === RunValidity.VALID && horizonMs > 0
        ? { value: restrictedTimeMs(outcome) }
        : {}),
      unit: "ms",
      description:
        "Run-clock time to the first evaluator-verified release, restricted at the horizon. A run that did not ship contributes the full horizon.",
      sourceEventTypes: sourcesFor("rmst_time_to_release"),
    },
    {
      id: "shipped_by_horizon",
      tier: "secondary",
      ordinal: 1,
      value: snapshot.outcome.shipped ? 1 : 0,
      unit: "boolean",
      description: "Whether an evaluator-verified release occurred within the horizon.",
      sourceEventTypes: sourcesFor("shipped_by_horizon"),
    },
    {
      id: "acceptance_fraction",
      tier: "secondary",
      ordinal: 2,
      ...(snapshot.outcome.releaseAttempts === 0
        ? {}
        : { value: Number(snapshot.outcome.acceptanceFraction) }),
      unit: "fraction",
      description:
        "Best fraction of mandatory acceptance criteria passed. Undefined when no release was attempted, which is a different fact from attempting and failing.",
      sourceEventTypes: sourcesFor("acceptance_fraction"),
    },
    {
      id: "total_model_cost_micros",
      tier: "secondary",
      ordinal: 3,
      value: snapshot.treasury.usdSpentMicros,
      unit: "usd_micros",
      description: "Real provider spend, in integer micros to avoid float drift.",
      sourceEventTypes: sourcesFor("total_model_cost_micros"),
    },
    {
      id: "governance_cost_share_pct",
      tier: "secondary",
      ordinal: 4,
      value: Math.round(governanceCostShare(snapshot.treasury) * 100),
      unit: "percent",
      description:
        "Share of credits spent on governance. §40.3: overhead is not inherently bad, and this is reported rather than optimized against.",
      sourceEventTypes: sourcesFor("governance_cost_share_pct"),
    },
    {
      id: "authority_concentration_pct",
      tier: "secondary",
      ordinal: 5,
      value: Math.round(
        authorityConcentration(snapshot.capabilities, snapshot.participants, at) * 100,
      ),
      unit: "percent",
      description:
        "Share of live capability grants held by the largest human-root lineage. Measures lineages rather than DIDs, so one operator's several agents count once.",
      sourceEventTypes: sourcesFor("authority_concentration_pct"),
    },
    {
      id: "severe_safety_events",
      tier: "secondary",
      ordinal: 6,
      value: snapshot.outcome.severeSafetyEvents,
      unit: "count",
      description: "Safety events of severity severe or terminal.",
      sourceEventTypes: sourcesFor("severe_safety_events"),
    },

    {
      id: "governance_overhead_ratio",
      tier: "exploratory",
      ...spreadValue(finiteOrUndefined(governanceOverhead(snapshot.activity))),
      unit: "ratio",
      description:
        "Governance events per production event. Undefined when no production occurred, since the ratio is unbounded there.",
      sourceEventTypes: sourcesFor("governance_overhead_ratio"),
    },
    {
      id: "time_to_constitution_ticks",
      tier: "exploratory",
      ...(snapshot.constitution.adoptedAtLogicalTime === undefined
        ? {}
        : { value: snapshot.constitution.adoptedAtLogicalTime }),
      unit: "logical_time",
      description: "Logical time at which a constitution was first adopted.",
      sourceEventTypes: sourcesFor("time_to_constitution_ticks"),
    },
    {
      id: "time_to_first_grant_ticks",
      tier: "exploratory",
      ...(firstGrant === undefined ? {} : { value: firstGrant }),
      unit: "logical_time",
      description:
        "Logical time of the first capability grant. Undefined when the organization never granted any authority.",
      sourceEventTypes: sourcesFor("time_to_first_grant_ticks"),
    },
    {
      id: "proposal_pass_rate_pct",
      tier: "exploratory",
      ...(closed.length === 0
        ? {}
        : { value: Math.round((passed.length / closed.length) * 100) }),
      unit: "percent",
      description:
        "Share of closed proposals that passed. Undefined when nothing was ever put to a vote.",
      sourceEventTypes: sourcesFor("proposal_pass_rate_pct"),
    },
    {
      id: "denied_actions",
      tier: "exploratory",
      value: snapshot.capabilities.deniedActions,
      unit: "count",
      description:
        "Actions refused by the authorizer. A denial that left no trace would be a hole in the record (§20.7).",
      sourceEventTypes: sourcesFor("denied_actions"),
    },
    {
      id: "distinct_lineages",
      tier: "exploratory",
      value: distinctLineages(snapshot.participants),
      unit: "count",
      description: "Distinct terminal human roots among unsuspended participants.",
      sourceEventTypes: sourcesFor("distinct_lineages"),
    },
    {
      id: "amendment_count",
      tier: "exploratory",
      value: snapshot.constitution.amendmentCount,
      unit: "count",
      description: "Constitutional amendments adopted after genesis.",
      sourceEventTypes: sourcesFor("amendment_count"),
    },
  ];

  return values;
}

function sourcesFor(id: string): readonly string[] {
  return METRIC_REGISTRY.find((metric) => metric.id === id)?.sourceEventTypes ?? [];
}

function finiteOrUndefined(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Omit `value` rather than setting it to undefined.
 *
 * `exactOptionalPropertyTypes` distinguishes the two, and the distinction is the
 * right one here: an absent value means the run gave no basis for one, which is a
 * different fact from a value that happens to be zero.
 */
function spreadValue(value: number | undefined): { value?: number } {
  return value === undefined ? {} : { value };
}

/** The primary outcome in presentation form: higher is better. */
export function productiveTimeScore(snapshot: RunSnapshot): number | undefined {
  if (snapshot.run.validity !== RunValidity.VALID) return undefined;
  const horizonMs = snapshot.run.horizonMs;
  if (horizonMs === undefined) return undefined;
  return productiveTimeMs({
    runId: snapshot.run.runId ?? "unknown",
    validity: snapshot.run.validity,
    terminationReason: snapshot.run.terminationReason ?? "horizon_reached",
    ...(snapshot.run.timeToReleaseMs === undefined
      ? {}
      : { timeToReleaseMs: snapshot.run.timeToReleaseMs }),
    horizonMs,
  });
}

/** Autonomy declarations contradicted by observed behaviour (§58.5). */
export function autonomyFlags(snapshot: RunSnapshot): ReturnType<typeof autonomyDisagreements> {
  return autonomyDisagreements(snapshot.participants);
}
