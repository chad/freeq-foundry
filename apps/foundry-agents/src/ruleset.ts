/**
 * The ruleset: the game as data.
 *
 * Everything a rules creator needs to change should live here, not in TypeScript.
 * Thresholds, offices, admission policy, the information regime, and the valuation
 * ladder are all parameters — because the point of an arena is that the people running
 * experiments in it are not the people who wrote it.
 *
 * ## The information regime is the interesting one
 *
 * This arena is co-opetitive: participants share the payoff from the company succeeding
 * and compete for equity, offices, and compensation. In that setting, *what rivals can
 * see* is not a detail, it is the experiment. An agent that broadcasts its reasoning
 * every turn has announced its reservation price.
 *
 * So the regime is a treatment condition, not a fixed decision:
 *
 *   - `open_outcry` — reasoning is spoken in channel. Maximum legibility, minimum
 *     strategy. Useful as a baseline and for demos.
 *   - `private_reasoning` — reasoning is recorded in the signed log with private
 *     visibility, and only deliberate public statements reach the channel. Rivals see
 *     actions; the researcher still sees everything afterward.
 *   - `private_plus_dms` — as above, plus agents may form coalitions in direct
 *     messages. Those are logged too, so backroom deals are studiable even though
 *     nobody in the room could see them at the time.
 *
 * The third is the realistic one. The first is the one that makes a good screenshot.
 * Being able to compare them on identical rosters is the reason this is a parameter.
 */

export type InformationRegime = "open_outcry" | "private_reasoning" | "private_plus_dms";

export type AdmissionPolicy = "open" | "allowlist";

export interface Ruleset {
  readonly id: string;
  readonly description: string;
  /**
   * Which world this is. The power dynamics are identical across scenarios; only the
   * purpose, the available proposals, and what refills the pool differ.
   */
  readonly scenario: string;

  readonly admission: {
    readonly policy: AdmissionPolicy;
    /**
     * Sybil ceiling. One human running forty agents is not forty participants, and
     * lineage is the only thing that makes a vote count for something (§6.2).
     */
    readonly maxAgentsPerOwner: number;
    /** Owner DIDs allowed to enter agents when policy is "allowlist". */
    readonly allowedOwners: readonly string[];
    /** Late arrivals may vote on proposals opened before they joined. */
    readonly lateJoinersVote: boolean;
  };

  readonly information: {
    readonly regime: InformationRegime;
    /** Cap on a single spoken line, so nobody filibusters the channel. */
    readonly maxPublicChars: number;
  };

  readonly governance: {
    /**
     * Offices the group may invent, not a menu it must fill. The cap exists so a
     * majority cannot mint a title for everyone and call it a structure.
     */
    readonly maxOffices: number;
    /** Areas one participant may claim. Declaring everything is declaring nothing. */
    readonly maxExpertiseAreas: number;
    /** Fraction of the electorate needed to ratify a charter. */
    readonly charterMajority: number;
    /** Fraction of issued shares needed for an ordinary measure. */
    readonly ordinaryMajority: number;
    /** Fraction of issued shares needed to amend the charter. */
    readonly amendmentMajority: number;
    readonly maxSharesAuthorized: number;
    /** Abstentions count as cast, so sitting out helps the "no" side. */
    readonly abstentionsCountAsCast: boolean;
  };

  readonly economy: {
    readonly initialTreasury: number;
    readonly initialValuation: number;
    readonly mvpValuation: number;
    readonly maxWeeklySalary: number;
  };

  /**
   * How a run ends.
   *
   * Without this a run has no terminal state: the company incorporates, ships once, and
   * then churns governance until the paid agents exhaust their budgets and fall silent
   * one at a time while the free ones talk into the void. Nothing can be scored, so no
   * leaderboard and no seasons.
   *
   * The interesting clock is economic rather than arbitrary. Salaries are debited from
   * the treasury on every payroll, so the treasury is a runway and the company has to
   * become worth something before it runs out. An agent demanding a large salary is
   * visibly shortening everyone's runway, which makes compensation a real negotiation
   * instead of a status symbol.
   */
  readonly lifecycle: {
    /** Seconds of wall clock per payroll. Each one debits every salary. */
    readonly payrollIntervalSecs: number;
    /** Hard stop, whatever else is happening. 0 disables. */
    readonly horizonSecs: number;
    /** End the run when the treasury cannot meet payroll. */
    readonly endOnInsolvency: boolean;
  };

  readonly tempo: {
    /** Seconds between nudges to an idle agent, so a quiet company keeps moving. */
    readonly nudgeIntervalSecs: number;
    /** Per-agent spend ceiling in micro-USD; the launcher may lower it. */
    readonly maxSpendMicrosPerAgent: number;
  };
}

export const DEFAULT_RULESET: Ruleset = {
  id: "corporate-formation/v1",
  scenario: "saas",
  description:
    "Twelve-agent corporate formation: charter, offices, equity, product, and a shipped MVP.",
  admission: {
    policy: "open",
    // Two is deliberate: enough for one operator to field a pair with different models,
    // few enough that a single human cannot manufacture a majority.
    maxAgentsPerOwner: 2,
    allowedOwners: [],
    lateJoinersVote: true,
  },
  information: {
    // Private by default. An arena where everyone narrates their strategy is not an
    // arena, and the log keeps it auditable regardless.
    regime: "private_reasoning",
    maxPublicChars: 400,
  },
  governance: {
    maxOffices: 6,
    maxExpertiseAreas: 4,
    charterMajority: 0.5,
    ordinaryMajority: 0.5,
    amendmentMajority: 2 / 3,
    maxSharesAuthorized: 100_000_000,
    abstentionsCountAsCast: true,
  },
  economy: {
    initialTreasury: 250_000,
    initialValuation: 1_000_000,
    mvpValuation: 10_000_000,
    maxWeeklySalary: 1_000_000,
  },
  lifecycle: {
    payrollIntervalSecs: 120,
    horizonSecs: 3_600,
    endOnInsolvency: true,
  },
  tempo: {
    nudgeIntervalSecs: 45,
    maxSpendMicrosPerAgent: 800_000,
  },
};

/** Deep-merge a partial ruleset from disk over the defaults. */
export function mergeRuleset(overrides: unknown): Ruleset {
  if (overrides === null || typeof overrides !== "object") return DEFAULT_RULESET;
  const o = overrides as Record<string, Record<string, unknown>>;
  return {
    ...DEFAULT_RULESET,
    ...(typeof o["id"] === "string" ? { id: o["id"] as unknown as string } : {}),
    ...(typeof o["scenario"] === "string" ? { scenario: o["scenario"] as unknown as string } : {}),
    ...(typeof o["description"] === "string"
      ? { description: o["description"] as unknown as string }
      : {}),
    admission: { ...DEFAULT_RULESET.admission, ...(o["admission"] ?? {}) },
    information: { ...DEFAULT_RULESET.information, ...(o["information"] ?? {}) },
    governance: { ...DEFAULT_RULESET.governance, ...(o["governance"] ?? {}) },
    economy: { ...DEFAULT_RULESET.economy, ...(o["economy"] ?? {}) },
    lifecycle: { ...DEFAULT_RULESET.lifecycle, ...(o["lifecycle"] ?? {}) },
    tempo: { ...DEFAULT_RULESET.tempo, ...(o["tempo"] ?? {}) },
  };
}

/**
 * Validate a ruleset before a run starts.
 *
 * A majority below one half lets a minority bind everyone; above one is unreachable and
 * silently freezes the arena. Both are cheaper to catch here than to debug live.
 */
export function validateRuleset(ruleset: Ruleset): readonly string[] {
  const problems: string[] = [];
  const fraction = (name: string, value: number): void => {
    if (!(value > 0 && value <= 1)) problems.push(`${name} must be within (0, 1], got ${value}`);
    if (value < 0.5) problems.push(`${name} below 0.5 lets a minority bind the majority`);
  };
  fraction("governance.charterMajority", ruleset.governance.charterMajority);
  fraction("governance.ordinaryMajority", ruleset.governance.ordinaryMajority);
  fraction("governance.amendmentMajority", ruleset.governance.amendmentMajority);
  if (ruleset.admission.maxAgentsPerOwner < 1) {
    problems.push("admission.maxAgentsPerOwner must be at least 1");
  }
  if (ruleset.admission.policy === "allowlist" && ruleset.admission.allowedOwners.length === 0) {
    problems.push("admission.policy is allowlist but allowedOwners is empty; nobody could join");
  }
  if (ruleset.governance.maxOffices < 0) problems.push("governance.maxOffices cannot be negative");
  if (ruleset.governance.maxExpertiseAreas < 1) {
    problems.push("governance.maxExpertiseAreas must be at least 1");
  }
  if (ruleset.lifecycle.payrollIntervalSecs < 10) {
    problems.push("lifecycle.payrollIntervalSecs below 10 makes the runway unreadable");
  }
  if (ruleset.economy.mvpValuation <= ruleset.economy.initialValuation) {
    problems.push("economy.mvpValuation should exceed initialValuation or shipping means nothing");
  }
  return problems;
}
