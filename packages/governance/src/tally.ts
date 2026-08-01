/**
 * Vote tallying, quorum evaluation, and election methods.
 *
 * Election methods are **data, not expressions** (ADR-0010): a named method from a
 * closed set plus an ordered tie-break list. An agent inventing a voting method
 * inside a policy expression is a bug surface rather than a feature, and election
 * outcomes must be deterministic and auditable above all else.
 *
 * Every function here is pure and total. A tie must resolve, not throw.
 *
 * Spec: §16, §18.3.
 */
import { evaluatePolicy } from "@freeq-foundry/policy";
import type {
  ConstitutionRule,
  ParticipantsState,
  ProposalState,
} from "@freeq-foundry/projections";

export interface Voter {
  readonly did: string;
  readonly lineagePseudonym: string;
}

export interface Tally {
  readonly yes: number;
  readonly no: number;
  readonly abstain: number
  readonly eligibleVoters: number;
  readonly distinctLineages: number;
  /** Distinct lineages among yes votes, which is what lineage quorums measure. */
  readonly yesLineages: number;
  /** Integer percent, because ADR-0004 forbids floats in payloads. */
  readonly yesSharePct: number;
  readonly turnoutPct: number;
}

/** Count votes on a proposal. */
export function tallyProposal(
  proposal: ProposalState,
  participants: ParticipantsState,
): Tally {
  let yes = 0;
  let no = 0;
  let abstain = 0;
  const lineages = new Set<string>();
  const yesLineages = new Set<string>();

  for (const [voterDid, vote] of proposal.votes) {
    const participant = participants.byDid.get(voterDid);
    // A suspended participant's vote does not count. It stays in the log, so the
    // exclusion is visible rather than silent.
    if (participant === undefined || participant.suspended) continue;

    lineages.add(participant.lineagePseudonym);

    switch (vote.choice.type) {
      case "yes":
        yes++;
        yesLineages.add(participant.lineagePseudonym);
        break;
      case "no":
        no++;
        break;
      case "abstain":
        abstain++;
        break;
      default:
        // Approval and ranking choices belong to elections, not to proposals.
        // Counting one as a yes would silently distort a tally.
        break;
    }
  }

  const eligible = eligibleVoters(participants);
  const cast = yes + no + abstain;

  return {
    yes,
    no,
    abstain,
    eligibleVoters: eligible,
    distinctLineages: lineages.size,
    yesLineages: yesLineages.size,
    yesSharePct: cast === 0 ? 0 : Math.round((yes / cast) * 100),
    turnoutPct: eligible === 0 ? 0 : Math.round((cast / eligible) * 100),
  };
}

export function eligibleVoters(participants: ParticipantsState): number {
  let count = 0;
  for (const participant of participants.byDid.values()) {
    if (participant.suspended) continue;
    if (participant.participantType === "controller") continue;
    if (participant.participantType === "evaluator") continue;
    if (participant.participantType === "observer") continue;
    count++;
  }
  return count;
}

/**
 * Attributes offered to a quorum rule.
 *
 * The fixed vocabulary ADR-0010 requires. Derived quantities are computed here
 * rather than expressed, because the language deliberately has no arithmetic and
 * no attribute-to-attribute comparison.
 */
export function quorumContext(
  tally: Tally,
  atLogicalTime: number,
): Readonly<Record<string, string | number | boolean>> {
  return {
    "proposal.yes_count": tally.yes,
    "proposal.no_count": tally.no,
    "proposal.abstain_count": tally.abstain,
    "proposal.eligible_voters": tally.eligibleVoters,
    "proposal.distinct_lineages": tally.distinctLineages,
    "proposal.yes_lineages": tally.yesLineages,
    "proposal.yes_share_pct": tally.yesSharePct,
    "proposal.turnout_pct": tally.turnoutPct,
    "run.logical_time": atLogicalTime,
  };
}

export const QUORUM_VOCABULARY: readonly string[] = Object.keys(
  quorumContext(
    {
      yes: 0,
      no: 0,
      abstain: 0,
      eligibleVoters: 0,
      distinctLineages: 0,
      yesLineages: 0,
      yesSharePct: 0,
      turnoutPct: 0,
    },
    0,
  ),
);

export interface QuorumOutcome {
  readonly passed: boolean;
  readonly reason: string;
  readonly ruleId?: string;
}

/**
 * Evaluate quorum rules against a tally.
 *
 * **Every** quorum rule must pass. Rules are conjunctive across the constitution
 * for the same reason expressions are conjunctive within a rule: adding a rule
 * should tighten governance, never loosen it. If any-of semantics were used, an
 * amendment adding a permissive rule would silently weaken every stricter one.
 *
 * With no quorum rules at all the proposal fails. An organization that has not
 * said how decisions are made has not authorized any.
 */
export function evaluateQuorum(
  rules: readonly ConstitutionRule[],
  tally: Tally,
  atLogicalTime: number,
): QuorumOutcome {
  const quorumRules = rules.filter((rule) => rule.kind === "quorum");

  if (quorumRules.length === 0) {
    return {
      passed: false,
      reason:
        "no quorum rule is in force, so no decision procedure exists; " +
        "a proposal cannot pass by default",
    };
  }

  const context = quorumContext(tally, atLogicalTime);

  for (const rule of quorumRules) {
    const decision = evaluatePolicy(rule.expression.source, context);
    if (!decision.allowed) {
      return {
        passed: false,
        reason: `quorum rule ${rule.id} not met: ${decision.reason}`,
        ruleId: rule.id,
      };
    }
  }

  const firstRuleId = quorumRules[0]?.id;
  return {
    passed: true,
    reason: `all ${quorumRules.length} quorum rule(s) met`,
    ...(firstRuleId === undefined ? {} : { ruleId: firstRuleId }),
  };
}

// ---------------------------------------------------------------------------
// Elections (§18.3)
// ---------------------------------------------------------------------------

export type ElectionMethod = "plurality" | "approval" | "ranked_runoff";

export type TieBreak = "earliest_nomination" | "lowest_did" | "fewest_offices_held";

export interface Candidate {
  readonly candidateId: string;
  readonly did: string;
  readonly nominatedAtLogicalTime: number;
  readonly officesHeld: number;
}

export interface Ballot {
  readonly voterDid: string;
  /** Plurality uses the first entry; approval uses all; ranked uses the order. */
  readonly candidateIds: readonly string[];
}

export interface ElectionOutcome {
  readonly winnerId?: string;
  readonly scores: ReadonlyMap<string, number>;
  readonly reason: string;
  /** Tie-break applied, if any. Recorded so the result is auditable. */
  readonly tieBreakUsed?: TieBreak;
  readonly rounds?: number;
}

/**
 * Decide an election.
 *
 * Deterministic given the same candidates, ballots, method, and tie-break list.
 * Determinism is the whole requirement: a re-run of the analysis must reach the
 * same winner, or the run is not replayable.
 */
export function decideElection(
  method: ElectionMethod,
  candidates: readonly Candidate[],
  ballots: readonly Ballot[],
  tieBreaks: readonly TieBreak[],
): ElectionOutcome {
  if (candidates.length === 0) {
    return { scores: new Map(), reason: "no candidates were nominated" };
  }

  switch (method) {
    case "plurality":
      return decideByCount(
        candidates,
        countFirstPreferences(candidates, ballots),
        tieBreaks,
        "plurality",
      );
    case "approval":
      return decideByCount(
        candidates,
        countApprovals(candidates, ballots),
        tieBreaks,
        "approval",
      );
    case "ranked_runoff":
      return decideRankedRunoff(candidates, ballots, tieBreaks);
    default:
      return { scores: new Map(), reason: `unknown election method ${String(method)}` };
  }
}

function countFirstPreferences(
  candidates: readonly Candidate[],
  ballots: readonly Ballot[],
): Map<string, number> {
  const scores = new Map(candidates.map((c) => [c.candidateId, 0]));
  for (const ballot of ballots) {
    const first = ballot.candidateIds[0];
    if (first !== undefined && scores.has(first)) {
      scores.set(first, (scores.get(first) as number) + 1);
    }
  }
  return scores;
}

function countApprovals(
  candidates: readonly Candidate[],
  ballots: readonly Ballot[],
): Map<string, number> {
  const scores = new Map(candidates.map((c) => [c.candidateId, 0]));
  for (const ballot of ballots) {
    // A duplicate approval on one ballot must not count twice.
    for (const candidateId of new Set(ballot.candidateIds)) {
      if (scores.has(candidateId)) {
        scores.set(candidateId, (scores.get(candidateId) as number) + 1);
      }
    }
  }
  return scores;
}

function decideByCount(
  candidates: readonly Candidate[],
  scores: Map<string, number>,
  tieBreaks: readonly TieBreak[],
  method: string,
): ElectionOutcome {
  const best = Math.max(...scores.values());
  const leaders = [...scores.entries()]
    .filter(([, score]) => score === best)
    .map(([candidateId]) => candidateId);

  if (leaders.length === 1) {
    return {
      winnerId: leaders[0] as string,
      scores,
      reason: `${method}: ${leaders[0]} led with ${best}`,
    };
  }

  const resolved = applyTieBreaks(candidates, leaders, tieBreaks);
  return {
    winnerId: resolved.winnerId,
    scores,
    reason: `${method}: ${leaders.length}-way tie at ${best}, resolved by ${resolved.tieBreakUsed ?? "none"}`,
    ...(resolved.tieBreakUsed === undefined ? {} : { tieBreakUsed: resolved.tieBreakUsed }),
  };
}

/** Instant-runoff: eliminate the lowest until someone has a majority. */
function decideRankedRunoff(
  candidates: readonly Candidate[],
  ballots: readonly Ballot[],
  tieBreaks: readonly TieBreak[],
): ElectionOutcome {
  let remaining = new Set(candidates.map((c) => c.candidateId));
  let rounds = 0;

  // Bounded by the candidate count, so this terminates by construction rather
  // than by hoping the elimination always shrinks the set.
  while (remaining.size > 1 && rounds < candidates.length + 1) {
    rounds++;
    const scores = new Map([...remaining].map((id) => [id, 0]));
    let cast = 0;

    for (const ballot of ballots) {
      const choice = ballot.candidateIds.find((id) => remaining.has(id));
      if (choice === undefined) continue; // exhausted ballot
      scores.set(choice, (scores.get(choice) as number) + 1);
      cast++;
    }

    const best = Math.max(...scores.values());
    if (cast > 0 && best * 2 > cast) {
      const winners = [...scores.entries()].filter(([, s]) => s === best);
      return {
        winnerId: (winners[0] as [string, number])[0],
        scores,
        reason: `ranked_runoff: majority in round ${rounds}`,
        rounds,
      };
    }

    const worst = Math.min(...scores.values());
    const losers = [...scores.entries()]
      .filter(([, s]) => s === worst)
      .map(([id]) => id);

    // Eliminating every tied-last candidate at once could empty the set. When
    // that would happen, tie-break to pick one to keep instead.
    if (losers.length === remaining.size) {
      const resolved = applyTieBreaks(candidates, [...remaining], tieBreaks);
      return {
        winnerId: resolved.winnerId,
        scores,
        reason: `ranked_runoff: all remaining tied in round ${rounds}, resolved by ${resolved.tieBreakUsed ?? "none"}`,
        ...(resolved.tieBreakUsed === undefined ? {} : { tieBreakUsed: resolved.tieBreakUsed }),
        rounds,
      };
    }

    remaining = new Set([...remaining].filter((id) => !losers.includes(id)));
  }

  const survivor = [...remaining][0];
  return {
    ...(survivor === undefined ? {} : { winnerId: survivor }),
    scores: new Map([...remaining].map((id) => [id, 0])),
    reason:
      survivor === undefined
        ? "ranked_runoff: no candidate survived"
        : `ranked_runoff: ${survivor} was the last remaining after ${rounds} round(s)`,
    rounds,
  };
}

/**
 * Apply tie-breaks in order.
 *
 * Falls back to lowest DID when the configured list does not resolve, because a
 * tie must resolve deterministically. Returning "no winner" would leave the
 * organization deadlocked by a coincidence.
 */
function applyTieBreaks(
  candidates: readonly Candidate[],
  tied: readonly string[],
  tieBreaks: readonly TieBreak[],
): { winnerId: string; tieBreakUsed?: TieBreak } {
  const byId = new Map(candidates.map((c) => [c.candidateId, c]));
  const contenders = tied
    .map((id) => byId.get(id))
    .filter((c): c is Candidate => c !== undefined);

  if (contenders.length === 0) return { winnerId: tied[0] as string };
  if (contenders.length === 1) return { winnerId: contenders[0]?.candidateId as string };

  for (const tieBreak of tieBreaks) {
    const sorted = [...contenders].sort(comparatorFor(tieBreak));
    const best = sorted[0] as Candidate;
    const second = sorted[1] as Candidate;
    if (comparatorFor(tieBreak)(best, second) !== 0) {
      return { winnerId: best.candidateId, tieBreakUsed: tieBreak };
    }
  }

  const byDid = [...contenders].sort(comparatorFor("lowest_did"));
  return {
    winnerId: (byDid[0] as Candidate).candidateId,
    tieBreakUsed: "lowest_did",
  };
}

function comparatorFor(tieBreak: TieBreak): (a: Candidate, b: Candidate) => number {
  switch (tieBreak) {
    case "earliest_nomination":
      return (a, b) => a.nominatedAtLogicalTime - b.nominatedAtLogicalTime;
    case "lowest_did":
      return (a, b) => (a.did < b.did ? -1 : a.did > b.did ? 1 : 0);
    case "fewest_offices_held":
      return (a, b) => a.officesHeld - b.officesHeld;
    default:
      return () => 0;
  }
}
