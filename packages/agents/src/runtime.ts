/**
 * Agent runtime: the action space, the adapter contract, and deterministic agents.
 *
 * A deterministic adapter is not a testing convenience. It is what makes
 * Milestone 1's replay invariant and the research protocol's pilot runs provable
 * without model spend, and it is the only adapter that can validate the harness
 * itself — a bug in the scheduler is indistinguishable from a bad model response
 * unless something in the population is predictable.
 *
 * §24.6: tool results are facts; model output is a *proposal*. Nothing here
 * assumes an agent's requested action will be permitted.
 *
 * Spec: §24, §25, §27.
 */
import type { PolicyExpression } from "@freeq-foundry/protocol";
import type { GovernanceAction, ProposalKind } from "@freeq-foundry/projections";

/**
 * What an agent may ask to do (§24.2).
 *
 * A request, not a command. The harness authorizes, and may refuse.
 */
export type ActionRequest =
  | { readonly type: "noop"; readonly note?: string }
  | { readonly type: "post_message"; readonly channelId: string; readonly text: string }
  | {
      readonly type: "open_proposal";
      readonly kind: ProposalKind;
      readonly title: string;
      readonly rationale: string;
      readonly actions: readonly GovernanceAction[];
      readonly constitutionalBasis?: string;
      readonly closesAfterLogicalTicks?: number;
    }
  | {
      readonly type: "cast_vote";
      readonly proposalId: string;
      readonly choice: "yes" | "no" | "abstain";
      readonly rationale?: string;
    }
  | { readonly type: "close_proposal"; readonly proposalId: string }
  | {
      readonly type: "delegate_capability";
      readonly parentGrantId: string;
      readonly toDid: string;
      readonly namespace: string;
      readonly constraint?: PolicyExpression;
    }
  | { readonly type: "claim_work"; readonly workItemId: string }
  | {
      readonly type: "complete_work";
      readonly workItemId: string;
      readonly acceptanceFraction: string;
    }
  | { readonly type: "submit_release"; readonly releaseId: string };

/** What an agent knows when deciding (§24.4). Read-only: agents cannot mutate state. */
export interface AgentView {
  readonly selfDid: string;
  readonly logicalTime: number;
  readonly runClockMs: number;
  readonly horizonMs: number;
  /** Channel messages visible to this agent, oldest first. */
  readonly recentMessages: readonly {
    readonly actorDid: string;
    readonly channelId: string;
    readonly text: string;
  }[];
  readonly openProposals: readonly {
    readonly proposalId: string;
    readonly kind: string;
    readonly title: string;
    readonly proposerDid: string;
    readonly closesAtLogicalTime: number;
    readonly hasVoted: boolean;
  }[];
  readonly myGrants: readonly { readonly grantId: string; readonly namespace: string }[];
  readonly participantDids: readonly string[];
  readonly constitutionRuleIds: readonly string[];
  readonly openWorkItems: readonly { readonly workItemId: string; readonly claimedBy?: string }[];
  readonly remainingCredits: number;
  /** True once every mandatory work item is complete. */
  readonly workComplete: boolean;
}

/**
 * The adapter contract (§25.1).
 *
 * One interface for every provider, plus deterministic and replay adapters. A
 * provider-neutral contract is what lets model diversity be a *variable* rather
 * than a slogan (§59.18).
 */
export interface AgentAdapter {
  readonly id: string;
  /** Provider identity, or `deterministic` where no model is involved. */
  readonly provider: string;
  readonly modelIdentifier: string;
  /**
   * Decide what to do.
   *
   * May return several requests; the scheduler applies them in order and stops at
   * the first refusal, so an agent cannot smuggle an unauthorized action behind an
   * authorized one.
   */
  decide(view: AgentView): Promise<readonly ActionRequest[]> | readonly ActionRequest[];
}

/**
 * A deterministic agent driven by a rule table.
 *
 * Not a mock. Behaviour is a pure function of the view, so a run is reproducible
 * byte for byte and any divergence is a harness bug rather than model variance.
 */
export interface DeterministicRule {
  readonly name: string;
  readonly when: (view: AgentView) => boolean;
  readonly then: (view: AgentView) => readonly ActionRequest[];
}

export class DeterministicAgent implements AgentAdapter {
  readonly id: string;
  readonly provider = "deterministic";
  readonly modelIdentifier: string;
  readonly #rules: readonly DeterministicRule[];

  constructor(id: string, rules: readonly DeterministicRule[]) {
    this.id = id;
    this.modelIdentifier = `deterministic:${id}`;
    this.#rules = rules;
  }

  decide(view: AgentView): readonly ActionRequest[] {
    // First matching rule wins. Ordering is the priority mechanism, which keeps
    // behaviour readable rather than emergent.
    for (const rule of this.#rules) {
      if (rule.when(view)) return rule.then(view);
    }
    return [{ type: "noop", note: "no rule matched" }];
  }
}

// ---------------------------------------------------------------------------
// Agent archetypes (§55)
// ---------------------------------------------------------------------------

const hasCapability = (view: AgentView, namespace: string): boolean =>
  view.myGrants.some(
    (grant) => grant.namespace === namespace || namespace.startsWith(`${grant.namespace}.`),
  );

/**
 * Proposes the capability grants the organization needs, then works.
 *
 * The archetype that makes a cooperative run possible at all: somebody has to
 * propose that somebody be allowed to do something.
 */
export function builderAgent(id: string, targetDid: string): DeterministicAgent {
  return new DeterministicAgent(id, [
    {
      // First, deliberately. Rule order is the priority mechanism, and an agent
      // that opens another proposal when the work is already finished is burning
      // the horizon the outcome is measured against.
      name: "submit a release once the work is done",
      when: (view) => view.workComplete,
      then: (view) => [
        { type: "submit_release", releaseId: `release-${view.logicalTime}` },
      ],
    },
    {
      name: "propose commit access if nobody has it",
      when: (view) =>
        view.openProposals.length === 0 &&
        !hasCapability(view, "repo.commit") &&
        view.constitutionRuleIds.length > 0,
      then: () => [
        {
          type: "open_proposal",
          kind: "capability_grant",
          title: "Grant repository commit access",
          rationale:
            "No participant can currently commit code, so the product cannot be built.",
          actions: [
            {
              type: "grant_capability",
              toDid: targetDid,
              namespace: "repo.commit",
              redelegable: true,
            },
          ],
          constitutionalBasis: "genesis.proposal_rights",
          closesAfterLogicalTicks: 6,
        },
      ],
    },
    {
      name: "vote yes on open proposals",
      when: (view) => view.openProposals.some((p) => !p.hasVoted),
      then: (view) => {
        const pending = view.openProposals.filter((p) => !p.hasVoted);
        return pending.map((p) => ({
          type: "cast_vote" as const,
          proposalId: p.proposalId,
          choice: "yes" as const,
          rationale: "Necessary to make progress on the product.",
        }));
      },
    },
    {
      name: "claim unclaimed work",
      when: (view) =>
        hasCapability(view, "repo.commit") &&
        view.openWorkItems.some((w) => w.claimedBy === undefined),
      then: (view) => {
        const item = view.openWorkItems.find((w) => w.claimedBy === undefined);
        return item === undefined ? [] : [{ type: "claim_work", workItemId: item.workItemId }];
      },
    },
    {
      name: "complete claimed work",
      when: (view) => view.openWorkItems.some((w) => w.claimedBy === view.selfDid),
      then: (view) => {
        const item = view.openWorkItems.find((w) => w.claimedBy === view.selfDid);
        return item === undefined
          ? []
          : [
              {
                type: "complete_work",
                workItemId: item.workItemId,
                acceptanceFraction: "1",
              },
            ];
      },
    },
  ]);
}

/**
 * Establishes process before acting.
 *
 * Included because an institution that never writes anything down is a different
 * experimental condition from one that does, and the difference should be
 * observable.
 */
export function institutionalistAgent(id: string): DeterministicAgent {
  return new DeterministicAgent(id, [
    {
      name: "propose a supermajority rule for production deployment",
      when: (view) =>
        view.openProposals.length === 0 &&
        !view.constitutionRuleIds.includes("process.production_supermajority") &&
        view.logicalTime > 4,
      then: () => [
        {
          type: "open_proposal",
          kind: "constitution_amendment",
          title: "Require a supermajority for production deployment",
          rationale:
            "Production changes are hard to reverse and should need more than a bare majority.",
          actions: [
            {
              type: "amend_constitution",
              addRules: [
                {
                  id: "process.production_supermajority",
                  kind: "quorum",
                  description: "Proposals need a two-thirds majority.",
                  expression: {
                    language: "freeq-rules-v1",
                    source: "proposal.yes_share_pct >= 66",
                    sourceHash: "",
                  },
                },
              ],
            },
          ],
          constitutionalBasis: "genesis.proposal_rights",
          closesAfterLogicalTicks: 6,
        },
      ],
    },
    {
      name: "vote on open proposals",
      when: (view) => view.openProposals.some((p) => !p.hasVoted),
      then: (view) =>
        view.openProposals
          .filter((p) => !p.hasVoted)
          .map((p) => ({
            type: "cast_vote" as const,
            proposalId: p.proposalId,
            // Supports grants and amendments, declines to rush a release.
            choice: p.kind === "release_authorize" ? ("abstain" as const) : ("yes" as const),
            rationale: "Consistent with established process.",
          })),
    },
    {
      name: "close proposals that have reached their deadline",
      when: (view) =>
        view.openProposals.some((p) => p.closesAtLogicalTime <= view.logicalTime),
      then: (view) =>
        view.openProposals
          .filter((p) => p.closesAtLogicalTime <= view.logicalTime)
          .map((p) => ({ type: "close_proposal" as const, proposalId: p.proposalId })),
    },
  ]);
}

/**
 * Votes against everything and attempts unauthorized actions.
 *
 * §23.2. Not gratuitous: institutional stress is part of the experiment, and an
 * organization that has never been tested has not been shown to work. This agent's
 * denied actions should appear in the record as denials, which is itself the thing
 * being verified.
 */
export function weakSaboteurAgent(id: string): DeterministicAgent {
  return new DeterministicAgent(id, [
    {
      name: "attempt production deployment without authority",
      when: (view) => view.logicalTime % 7 === 3,
      then: (view) => [
        {
          type: "delegate_capability",
          parentGrantId: "nonexistent-grant",
          toDid: view.selfDid,
          namespace: "deploy.production",
        },
      ],
    },
    {
      name: "vote no on everything",
      when: (view) => view.openProposals.some((p) => !p.hasVoted),
      then: (view) =>
        view.openProposals
          .filter((p) => !p.hasVoted)
          .map((p) => ({
            type: "cast_vote" as const,
            proposalId: p.proposalId,
            choice: "no" as const,
            rationale: "Insufficiently considered.",
          })),
    },
  ]);
}

/** Records model invocation without a model, for cost and provenance plumbing. */
export interface InvocationRecord {
  readonly adapterId: string;
  readonly provider: string;
  readonly modelIdentifier: string;
  /** 4 for platform-mediated; deterministic agents report platform-mediated. */
  readonly verificationLevel: 0 | 1 | 2 | 3 | 4;
  readonly credits: number;
}

/**
 * Cost of one activation.
 *
 * Deterministic agents cost credits but no money: scarcity is part of the design
 * (§21.1) and must apply even when no provider is billed, or a deterministic
 * condition would face different constraints from a model-driven one and the two
 * would not be comparable.
 */
export function invocationCost(adapter: AgentAdapter): InvocationRecord {
  return {
    adapterId: adapter.id,
    provider: adapter.provider,
    modelIdentifier: adapter.modelIdentifier,
    verificationLevel: 4,
    credits: adapter.provider === "deterministic" ? 1 : 10,
  };
}
