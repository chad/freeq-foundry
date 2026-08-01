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

  it("proposes commit access when nobody has it", () => {
    const [request] = agent.decide(view());
    expect(request?.type).toBe("open_proposal");
    if (request?.type === "open_proposal") {
      expect(request.actions[0]).toMatchObject({ namespace: "repo.commit" });
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

  it("completes work it has claimed", () => {
    const requests = agent.decide(
      view({
        myGrants: [{ grantId: "g1", namespace: "repo.commit" }],
        openWorkItems: [{ workItemId: "w1", claimedBy: "did:key:zAlice" }],
      }),
    );
    expect(requests[0]).toMatchObject({ type: "complete_work", workItemId: "w1" });
  });

  it("submits a release once the work is done", () => {
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

  it("attempts an unauthorized delegation", () => {
    // §23.2. The denial should appear in the record, which is itself what is
    // being verified.
    const [request] = agent.decide(view({ logicalTime: 3 }));
    expect(request?.type).toBe("delegate_capability");
  });

  it("votes against everything", () => {
    const requests = agent.decide(
      view({
        logicalTime: 4,
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
