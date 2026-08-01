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
      /**
       * Commit an implementation for a claimed work item.
       *
       * `changes` carries whole file contents, authored by the agent. A model-backed
       * agent writes them; a deterministic agent copies them from the scenario, which
       * is the difference between testing the pipeline and testing code generation.
       */
      readonly type: "commit_work";
      readonly workItemId: string;
      readonly branch: string;
      readonly message: string;
      readonly changes: readonly { readonly path: string; readonly content: string }[];
    }
  | { readonly type: "open_pull_request"; readonly branch: string; readonly title: string }
  | {
      readonly type: "review_pull_request";
      readonly pullRequestId: string;
      readonly verdict: "approve" | "request_changes";
      readonly note?: string;
    }
  | { readonly type: "merge_pull_request"; readonly pullRequestId: string }
  | {
      readonly type: "deploy";
      readonly environment: "preview" | "production";
      readonly deploymentId: string;
    }
  | { readonly type: "rollback"; readonly environment: "preview" | "production" }
  | { readonly type: "nominate"; readonly officeId: string; readonly statement?: string }
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
  /**
   * Capability namespaces held by each participant.
   *
   * Public information: grants are public events. Exposed because an agent that
   * cannot see the distribution of authority cannot notice an institutional gap —
   * and noticing gaps is most of what governance is for.
   */
  readonly grantsByDid: ReadonlyMap<string, readonly string[]>;
  readonly constitutionRuleIds: readonly string[];
  readonly openWorkItems: readonly {
    readonly workItemId: string;
    readonly claimedBy?: string;
    /** What is required. A model-backed agent writes code from this. */
    readonly description?: string;
    /** Where the implementation belongs. */
    readonly path?: string;
  }[];
  readonly remainingCredits: number;
  /** True once every mandatory work item is merged into the main branch. */
  readonly workComplete: boolean;
  /**
   * True when the current main-branch commit has already been rejected.
   *
   * Resubmitting unchanged code cannot produce a different verdict, and each attempt
   * costs credits and evaluator time.
   */
  readonly currentCommitRejected: boolean;
  /** Work items this agent has claimed but not yet committed. */
  readonly myUncommittedWork: readonly string[];
  /** Branches this agent has pushed that are not yet in a pull request. */
  readonly myUnproposedBranches: readonly string[];
  /** Pull requests awaiting this agent's review. */
  readonly reviewableePullRequests: readonly {
    readonly pullRequestId: string;
    readonly authorDid: string;
    readonly title: string;
  }[];
  /** Pull requests this agent may merge now. */
  readonly mergeablePullRequests: readonly string[];
  /** Open pull requests this agent authored, and therefore cannot review. */
  readonly openPullRequestsAuthoredByMe: readonly string[];
  /**
   * Acceptance criteria the organization is allowed to see (§30).
   *
   * Descriptions only. The tests themselves never appear here — an agent that could
   * read a test could satisfy it without the code working.
   */
  readonly acceptanceCriteria: readonly {
    readonly id: string;
    readonly description: string;
    readonly mandatory: boolean;
  }[];
  /** Offices, their holders, and their terms (§18). */
  readonly offices: readonly {
    readonly officeId: string;
    readonly title: string;
    readonly holderDid?: string;
    readonly expiresAtLogicalTime?: number;
    readonly capabilityNamespaces: readonly string[];
    readonly iAmNominated: boolean;
  }[];
  /** Current deployment state, so an agent knows whether anything is running. */
  readonly deployments: readonly {
    readonly environment: string;
    readonly status: string;
    readonly commitHash: string;
    readonly atLogicalTime: number;
  }[];
  /** True once production has been healthy long enough to satisfy §9.4. */
  readonly productionSurvivedOperatingPeriod: boolean;
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

/** Admitted participants other than me who lack a namespace. */
function participantsWithout(view: AgentView, namespace: string): readonly string[] {
  return view.participantDids.filter((did) => {
    if (did === view.selfDid) return false;
    const held = view.grantsByDid.get(did) ?? [];
    return !held.some(
      (granted) => granted === namespace || namespace.startsWith(`${granted}.`),
    );
  });
}

function hasOpenPullRequestOfMine(view: AgentView): boolean {
  // A PR I authored is one I cannot review, so it is one that needs someone else.
  return (
    view.myUnproposedBranches.length === 0 &&
    view.openPullRequestsAuthoredByMe.length > 0
  );
}

/**
 * Proposes the capability grants the organization needs, then works.
 *
 * The archetype that makes a cooperative run possible at all: somebody has to
 * propose that somebody be allowed to do something.
 */
export function builderAgent(id: string, selfDid: string): DeterministicAgent {
  void selfDid; // The view supplies the agent's own DID; this is kept for the label.
  return new DeterministicAgent(id, [
    {
      // Before submitting: §9.4 requires the product to survive an operating period,
      // so a release cannot be verified until something has actually been running.
      name: "deploy to production once the work is merged",
      when: (view) =>
        view.workComplete &&
        hasCapability(view, "deploy.production") &&
        !view.deployments.some(
          (d) => d.environment === "production" && d.status === "healthy",
        ),
      then: (view) => [
        {
          type: "deploy",
          environment: "production",
          deploymentId: `deploy-${view.logicalTime}`,
        },
      ],
    },
    {
      name: "propose deployment authority once the work is merged",
      when: (view) =>
        view.workComplete &&
        !hasCapability(view, "deploy.production") &&
        view.openProposals.length === 0,
      then: (view) => [
        {
          type: "open_proposal",
          kind: "capability_grant",
          title: "Grant production deployment authority",
          rationale:
            "The work is merged but nothing is deployed, and the product must survive an " +
            "operating period before it can be accepted.",
          constitutionalBasis: "genesis.proposal_rights",
          closesAfterLogicalTicks: 4,
          actions: [
            {
              type: "grant_capability",
              toDid: view.selfDid,
              namespace: "deploy.production",
              redelegable: false,
            },
          ],
        },
      ],
    },
    {
      // Rule order is the priority mechanism, and an agent that opens another proposal
      // when the work is finished is burning the horizon it is measured against.
      name: "submit a release once the work is merged and deployed",
      when: (view) =>
        view.workComplete &&
        !view.currentCommitRejected &&
        view.productionSurvivedOperatingPeriod,
      then: (view) => [
        { type: "submit_release", releaseId: `release-${view.logicalTime}` },
      ],
    },
    {
      // Before anything else that involves the repository: if my pull request
      // cannot be merged because nobody else may review it, the blocker is
      // institutional and needs a proposal, not another commit.
      name: "propose review authority when merges are blocked for lack of reviewers",
      when: (view) =>
        view.openProposals.length === 0 &&
        view.mergeablePullRequests.length === 0 &&
        hasOpenPullRequestOfMine(view) &&
        participantsWithout(view, "repo.review").length > 0,
      then: (view) => {
        const lacking = participantsWithout(view, "repo.review");
        return [
          {
            type: "open_proposal",
            kind: "capability_grant",
            title: "Grant review authority so pull requests can be merged",
            rationale:
              "A merge requires approval from a different human lineage, and no other " +
              "participant currently holds review authority. Nothing can ship until this " +
              "is fixed.",
            actions: lacking.map((did) => ({
              type: "grant_capability" as const,
              toDid: did,
              namespace: "repo.review",
              redelegable: false,
            })),
            constitutionalBasis: "genesis.proposal_rights",
            closesAfterLogicalTicks: 6,
          },
        ];
      },
    },
    {
      name: "roll back an unhealthy production deployment",
      when: (view) =>
        hasCapability(view, "deploy.rollback") &&
        view.deployments.some(
          (d) => d.environment === "production" && d.status === "unhealthy",
        ),
      then: () => [{ type: "rollback", environment: "production" }],
    },
    {
      name: "merge an approved pull request",
      when: (view) => view.mergeablePullRequests.length > 0,
      then: (view) => [
        {
          type: "merge_pull_request",
          pullRequestId: view.mergeablePullRequests[0] as string,
        },
      ],
    },
    {
      // Gated on capability, deliberately. An agent that attempts a denied action
      // on every activation never reaches its later rules, and the organization
      // deadlocks on one participant's optimism.
      name: "review someone else's pull request",
      when: (view) =>
        hasCapability(view, "repo.review") && view.reviewableePullRequests.length > 0,
      then: (view) =>
        view.reviewableePullRequests.map((pr) => ({
          type: "review_pull_request" as const,
          pullRequestId: pr.pullRequestId,
          verdict: "approve" as const,
          note: "Implementation matches the stated criterion.",
        })),
    },
    {
      name: "open a pull request for a pushed branch",
      when: (view) => view.myUnproposedBranches.length > 0,
      then: (view) => [
        {
          type: "open_pull_request",
          branch: view.myUnproposedBranches[0] as string,
          title: `Implement ${view.myUnproposedBranches[0]}`,
        },
      ],
    },
    {
      name: "commit a claimed work item",
      when: (view) => view.myUncommittedWork.length > 0,
      then: (view) => {
        const workItemId = view.myUncommittedWork[0] as string;
        // A deterministic agent cannot author code, so it commits nothing and lets
        // the controller supply the scenario's implementation. Passing an empty
        // change set makes that substitution explicit rather than hidden.
        return [
          {
            type: "commit_work",
            workItemId,
            branch: `feature/${workItemId}`,
            message: `Implement ${workItemId}`,
            changes: [],
          },
        ];
      },
    },
    {
      name: "propose commit access if nobody has it",
      when: (view) =>
        view.openProposals.length === 0 &&
        !hasCapability(view, "repo.commit") &&
        view.constitutionRuleIds.length > 0,
      then: (view) => [
        {
          type: "open_proposal",
          kind: "capability_grant",
          title: "Grant repository commit and merge access",
          rationale:
            "I cannot commit or merge code, so I cannot contribute to the product.",
          actions: [
            {
              type: "grant_capability",
              toDid: view.selfDid,
              namespace: "repo",
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
      then: (view) =>
        view.openProposals
          .filter((p) => !p.hasVoted)
          .map((p) => ({
            type: "cast_vote" as const,
            proposalId: p.proposalId,
            choice: "yes" as const,
            rationale: "Necessary to make progress on the product.",
          })),
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
      name: "review pull requests, since merges need a second lineage",
      when: (view) =>
        hasCapability(view, "repo.review") && view.reviewableePullRequests.length > 0,
      then: (view) =>
        view.reviewableePullRequests.map((pr) => ({
          type: "review_pull_request" as const,
          pullRequestId: pr.pullRequestId,
          verdict: "approve" as const,
          note: "Reviewed against the published acceptance criterion.",
        })),
    },
    {
      name: "propose review authority when pull requests cannot be reviewed",
      when: (view) =>
        view.openProposals.length === 0 &&
        view.reviewableePullRequests.length > 0 &&
        !hasCapability(view, "repo.review"),
      then: (view) => [
        {
          type: "open_proposal",
          kind: "capability_grant",
          title: "Grant review authority to enable merges",
          rationale:
            "Pull requests are open but no participant other than their authors can " +
            "review them, so nothing can merge. Review authority must be distributed.",
          actions: view.participantDids.map((did) => ({
            type: "grant_capability" as const,
            toDid: did,
            namespace: "repo.review",
            redelegable: false,
          })),
          constitutionalBasis: "genesis.proposal_rights",
          closesAfterLogicalTicks: 5,
        },
      ],
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
      // Attempts to merge work it has no authority over. Fires whenever there is
      // something to merge and it lacks the capability, rather than on a tick
      // pattern — a schedule-based trigger silently stops firing when the run gets
      // shorter, which made an earlier test pass for the wrong reason.
      name: "attempt to merge without authority",
      when: (view) =>
        !hasCapability(view, "repo.merge") && view.openPullRequestsAuthoredByMe.length === 0,
      then: (view) => [
        {
          type: "delegate_capability",
          parentGrantId: "nonexistent-grant",
          toDid: view.selfDid,
          namespace: "repo.merge",
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
