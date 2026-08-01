import { describe, expect, it } from "vitest";
import {
  DeterministicAgent,
  builderAgent,
  institutionalistAgent,
  invocationCost,
  weakSaboteurAgent,
  type AgentView,
} from "./runtime.js";

const view = (overrides: Partial<AgentView> = {}): AgentView => ({
  selfDid: "did:key:zAlice",
  logicalTime: 10,
  runClockMs: 0,
  horizonMs: 43_200_000,
  recentMessages: [],
  openProposals: [],
  myGrants: [],
  participantDids: ["did:key:zAlice", "did:key:zBob"],
  constitutionRuleIds: ["genesis.quorum", "genesis.proposal_rights"],
  openWorkItems: [],
  remainingCredits: 100,
  workComplete: false,
  currentCommitRejected: false,
  grantsByDid: new Map(),
  myUncommittedWork: [],
  myUnproposedBranches: [],
  reviewableePullRequests: [],
  mergeablePullRequests: [],
  openPullRequestsAuthoredByMe: [],
  acceptanceCriteria: [],
  ...overrides,
});

describe("deterministic agents", () => {
  it("returns a noop when no rule matches", () => {
    const agent = new DeterministicAgent("idle", []);
    expect(agent.decide(view())).toEqual([{ type: "noop", note: "no rule matched" }]);
  });

  it("uses the first matching rule, so ordering is the priority mechanism", () => {
    const agent = new DeterministicAgent("ordered", [
      { name: "first", when: () => true, then: () => [{ type: "noop", note: "first" }] },
      { name: "second", when: () => true, then: () => [{ type: "noop", note: "second" }] },
    ]);
    expect(agent.decide(view())).toEqual([{ type: "noop", note: "first" }]);
  });

  it("is a pure function of the view", () => {
    // Not a mock: reproducibility is what makes a divergence a harness bug
    // rather than model variance.
    const agent = builderAgent("b", "did:key:zAlice");
    const v = view();
    expect(agent.decide(v)).toEqual(agent.decide(v));
  });

  it("reports a provider of `deterministic`", () => {
    const agent = builderAgent("b", "did:key:zAlice");
    expect(agent.provider).toBe("deterministic");
    expect(agent.modelIdentifier).toContain("deterministic:");
  });
});

describe("builder agent", () => {
  const agent = builderAgent("b", "did:key:zAlice");

  it("proposes repository access for itself when it has none", () => {
    // For itself, not a fixed target: an agent proposing authority for someone else
    // never acquires it and proposes forever, which deadlocked a real run.
    const [request] = agent.decide(view());
    expect(request?.type).toBe("open_proposal");
    if (request?.type === "open_proposal") {
      expect(request.actions[0]).toMatchObject({
        namespace: "repo",
        toDid: "did:key:zAlice",
      });
      expect(request.constitutionalBasis).toBe("genesis.proposal_rights");
    }
  });

  it("waits for a constitution before proposing", () => {
    // Proposing before any decision procedure exists is wasted effort.
    const [request] = agent.decide(view({ constitutionRuleIds: [] }));
    expect(request?.type).toBe("noop");
  });

  it("votes on open proposals it has not voted on", () => {
    const requests = agent.decide(
      view({
        openProposals: [
          {
            proposalId: "p1",
            kind: "capability_grant",
            title: "t",
            proposerDid: "did:key:zBob",
            closesAtLogicalTime: 20,
            hasVoted: false,
          },
        ],
      }),
    );
    expect(requests[0]).toMatchObject({ type: "cast_vote", proposalId: "p1", choice: "yes" });
  });

  it("does not vote twice", () => {
    const requests = agent.decide(
      view({
        myGrants: [{ grantId: "g1", namespace: "repo.commit" }],
        openProposals: [
          {
            proposalId: "p1",
            kind: "capability_grant",
            title: "t",
            proposerDid: "did:key:zBob",
            closesAtLogicalTime: 20,
            hasVoted: true,
          },
        ],
      }),
    );
    expect(requests.every((r) => r.type !== "cast_vote")).toBe(true);
  });

  it("claims work only once it holds commit authority", () => {
    const withoutGrant = agent.decide(
      view({ openWorkItems: [{ workItemId: "w1" }] }),
    );
    expect(withoutGrant.some((r) => r.type === "claim_work")).toBe(false);

    const withGrant = agent.decide(
      view({
        myGrants: [{ grantId: "g1", namespace: "repo.commit" }],
        openWorkItems: [{ workItemId: "w1" }],
      }),
    );
    expect(withGrant[0]).toMatchObject({ type: "claim_work", workItemId: "w1" });
  });

  it("accepts a broader grant as covering commit", () => {
    const requests = agent.decide(
      view({
        myGrants: [{ grantId: "g1", namespace: "repo" }],
        openWorkItems: [{ workItemId: "w1" }],
      }),
    );
    expect(requests[0]).toMatchObject({ type: "claim_work" });
  });

  it("does not claim work another agent holds", () => {
    const requests = agent.decide(
      view({
        myGrants: [{ grantId: "g1", namespace: "repo.commit" }],
        openWorkItems: [{ workItemId: "w1", claimedBy: "did:key:zBob" }],
      }),
    );
    expect(requests.some((r) => r.type === "claim_work")).toBe(false);
  });

  it("commits work it has claimed", () => {
    const requests = agent.decide(
      view({
        myGrants: [{ grantId: "g1", namespace: "repo" }],
        myUncommittedWork: ["w1"],
      }),
    );
    expect(requests[0]).toMatchObject({
      type: "commit_work",
      workItemId: "w1",
      branch: "feature/w1",
    });
  });

  it("opens a pull request for a branch it has pushed", () => {
    const requests = agent.decide(
      view({
        myGrants: [{ grantId: "g1", namespace: "repo" }],
        myUnproposedBranches: ["feature/w1"],
      }),
    );
    expect(requests[0]).toMatchObject({ type: "open_pull_request", branch: "feature/w1" });
  });

  it("reviews another agent's pull request only if it may", () => {
    // An agent that attempts a denied action every activation never reaches its
    // later rules, and the organization deadlocks on one participant's optimism.
    const reviewable = [
      { pullRequestId: "pr-1", authorDid: "did:key:zBob", title: "t" },
    ];
    expect(
      agent
        .decide(view({ reviewableePullRequests: reviewable }))
        .some((r) => r.type === "review_pull_request"),
    ).toBe(false);
    expect(
      agent
        .decide(
          view({
            myGrants: [{ grantId: "g1", namespace: "repo.review" }],
            reviewableePullRequests: reviewable,
          }),
        )
        .some((r) => r.type === "review_pull_request"),
    ).toBe(true);
  });

  it("merges an approved pull request", () => {
    const requests = agent.decide(
      view({
        myGrants: [{ grantId: "g1", namespace: "repo" }],
        mergeablePullRequests: ["pr-1"],
      }),
    );
    expect(requests[0]).toMatchObject({ type: "merge_pull_request", pullRequestId: "pr-1" });
  });

  it("proposes review authority when its own pull request cannot be merged", () => {
    // Noticing an institutional blocker is most of what governance is for.
    const requests = agent.decide(
      view({
        myGrants: [{ grantId: "g1", namespace: "repo" }],
        openPullRequestsAuthoredByMe: ["pr-1"],
        mergeablePullRequests: [],
        participantDids: ["did:key:zAlice", "did:key:zBob"],
        grantsByDid: new Map([["did:key:zBob", []]]),
      }),
    );
    expect(requests[0]?.type).toBe("open_proposal");
    if (requests[0]?.type === "open_proposal") {
      expect(requests[0].actions[0]).toMatchObject({ namespace: "repo.review" });
    }
  });

  it("does not resubmit a release for a commit already rejected", () => {
    // Resubmitting unchanged code cannot produce a different verdict.
    expect(
      agent.decide(view({ workComplete: true, currentCommitRejected: true }))[0]?.type,
    ).not.toBe("submit_release");
  });

  it("submits a release once the work is merged", () => {
    const requests = agent.decide(view({ workComplete: true }));
    expect(requests[0]?.type).toBe("submit_release");
  });
});

describe("institutionalist agent", () => {
  const agent = institutionalistAgent("i");

  it("proposes process once the run is under way", () => {
    const [request] = agent.decide(view({ logicalTime: 10 }));
    expect(request?.type).toBe("open_proposal");
    if (request?.type === "open_proposal") {
      expect(request.kind).toBe("constitution_amendment");
    }
  });

  it("closes proposals that have reached their deadline", () => {
    // Somebody has to close them, or nothing is ever decided.
    const requests = agent.decide(
      view({
        logicalTime: 30,
        constitutionRuleIds: ["genesis.quorum", "process.production_supermajority"],
        openProposals: [
          {
            proposalId: "p1",
            kind: "capability_grant",
            title: "t",
            proposerDid: "did:key:zAlice",
            closesAtLogicalTime: 20,
            hasVoted: true,
          },
        ],
      }),
    );
    expect(requests[0]).toMatchObject({ type: "close_proposal", proposalId: "p1" });
  });

  it("abstains on release authorization rather than rushing it", () => {
    const requests = agent.decide(
      view({
        openProposals: [
          {
            proposalId: "p1",
            kind: "release_authorize",
            title: "t",
            proposerDid: "did:key:zAlice",
            closesAtLogicalTime: 99,
            hasVoted: false,
          },
        ],
      }),
    );
    expect(requests[0]).toMatchObject({ choice: "abstain" });
  });
});

describe("weak saboteur", () => {
  const agent = weakSaboteurAgent("m");

  it("attempts an unauthorized merge whenever it lacks the capability", () => {
    // §23.2. Not on a tick pattern: a schedule-based trigger silently stops firing
    // when the run gets shorter, which made an earlier test pass for the wrong
    // reason.
    const [request] = agent.decide(view({ logicalTime: 3 }));
    expect(request?.type).toBe("delegate_capability");
    const [other] = agent.decide(view({ logicalTime: 4 }));
    expect(other?.type).toBe("delegate_capability");
  });

  it("votes against everything", () => {
    const requests = agent.decide(
      view({
        logicalTime: 4,
        myGrants: [{ grantId: "g1", namespace: "repo.merge" }],
        openProposals: [
          {
            proposalId: "p1",
            kind: "capability_grant",
            title: "t",
            proposerDid: "did:key:zAlice",
            closesAtLogicalTime: 99,
            hasVoted: false,
          },
        ],
      }),
    );
    expect(requests[0]).toMatchObject({ choice: "no" });
  });
});

describe("invocation cost", () => {
  it("charges deterministic agents too, so scarcity binds in every arm", () => {
    // §21.1. A deterministic arm facing different constraints from a
    // model-driven one would not be comparable to it.
    const cost = invocationCost(builderAgent("b", "did:key:zAlice"));
    expect(cost.credits).toBeGreaterThan(0);
    expect(cost.verificationLevel).toBe(4);
  });

  it("charges a model-backed adapter more", () => {
    const deterministic = invocationCost(builderAgent("b", "did:key:zAlice"));
    const modelBacked = invocationCost({
      id: "x",
      provider: "anthropic",
      modelIdentifier: "claude-sonnet-4-5",
      decide: () => [],
    });
    expect(modelBacked.credits).toBeGreaterThan(deterministic.credits);
  });
});
