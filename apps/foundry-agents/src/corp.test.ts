/**
 * The rules of the game, tested before real money plays it.
 *
 * These tests exist because twelve agents with real budgets are about to negotiate
 * under these rules on a live server. A bug here isn't a failed test — it's an agent
 * publicly cheated by arithmetic nobody audited.
 */
import { describe, expect, it } from "vitest";
import { mergeRuleset } from "./ruleset.js";
import { COMMONS_SCENARIO } from "./scenario.js";
import {
  castVote,
  completeWork,
  declareExpertise,
  endAtHorizon,
  runPayroll,
  initialCorpState,
  mayOpen,
  openProposal,
  sharesOf,
  standing,
  totalIssued,
  INITIAL_TREASURY,
  INITIAL_VALUATION,
  MVP_VALUATION,
  type CorpState,
} from "./corp.js";

const ROSTER = Array.from({ length: 12 }, (_, i) => `did:key:agent-${i}`);
const [A, B, C, D, E, F, G, H, I, J, K, L] = ROSTER as [
  string, string, string, string, string, string,
  string, string, string, string, string, string,
];

const CHARTER = {
  companyName: "Acme SaaS",
  mission: "sell software",
  sharesAuthorized: 10_000_000,
  founders: [
    { did: A, shares: 2_000_000 },
    { did: B, shares: 1_500_000 },
    { did: C, shares: 1_000_000 },
    { did: D, shares: 500_000 },
  ],
};

/** Open + pass the charter with 7 yes votes. */
function incorporated(): CorpState {
  let state = initialCorpState();
  const opened = openProposal(
    state,
    { id: "p-charter", kind: "charter", title: "Charter", rationale: "", proposerDid: A, payload: CHARTER },
    ROSTER,
  );
  expect(opened.ok).toBe(true);
  state = opened.state;
  for (const voter of [A, B, C, D, E, F, G]) {
    const result = castVote(state, "p-charter", voter, "yes", ROSTER);
    expect(result.ok).toBe(true);
    state = result.state;
  }
  expect(state.phase).toBe("incorporated");
  return state;
}

describe("the founding", () => {
  it("a charter needs 7 of 12 — six yes votes is not a company", () => {
    let state = initialCorpState();
    state = openProposal(
      state,
      { id: "p1", kind: "charter", title: "", rationale: "", proposerDid: A, payload: CHARTER },
      ROSTER,
    ).state;
    for (const voter of [A, B, C, D, E, F]) {
      state = castVote(state, "p1", voter, "yes", ROSTER).state;
    }
    expect(state.phase).toBe("unformed");
    expect(state.proposals.get("p1")?.status).toBe("open");
  });

  it("the seventh yes incorporates, allocates, and funds the treasury", () => {
    const state = incorporated();
    expect(state.companyName).toBe("Acme SaaS");
    expect(sharesOf(state, A)).toBe(2_000_000);
    expect(totalIssued(state)).toBe(5_000_000);
    expect(state.treasury).toBe(INITIAL_TREASURY);
    expect(state.valuation).toBe(INITIAL_VALUATION);
  });

  it("a charter fails the moment 7 becomes unreachable", () => {
    let state = initialCorpState();
    state = openProposal(
      state,
      { id: "p1", kind: "charter", title: "", rationale: "", proposerDid: A, payload: CHARTER },
      ROSTER,
    ).state;
    // Six no votes: at most 6 yes remain, and 6 < 7.
    for (const voter of [A, B, C, D, E, F]) {
      state = castVote(state, "p1", voter, "no", ROSTER).state;
    }
    expect(state.proposals.get("p1")?.status).toBe("failed");
  });

  it("rejects a charter that allocates more than it authorizes", () => {
    const result = openProposal(
      initialCorpState(),
      {
        id: "p1", kind: "charter", title: "", rationale: "", proposerDid: A,
        payload: { ...CHARTER, founders: [{ did: A, shares: 20_000_000 }] },
      },
      ROSTER,
    );
    expect(result.ok).toBe(false);
  });

  it("only a charter may be proposed before incorporation", () => {
    const allowed = mayOpen(initialCorpState(), "equity_grant", A, ROSTER);
    expect(allowed.ok).toBe(false);
    expect(mayOpen(initialCorpState(), "charter", A, ROSTER).ok).toBe(true);
  });

  it("nobody outside the twelve may play", () => {
    const result = openProposal(
      initialCorpState(),
      { id: "p1", kind: "charter", title: "", rationale: "", proposerDid: "did:key:rando", payload: CHARTER },
      ROSTER,
    );
    expect(result.ok).toBe(false);
  });
});

describe("share-weighted governance", () => {
  it("votes are weighted by shares: the big founder outvotes three small ones", () => {
    let state = incorporated(); // A=2M, B=1.5M, C=1M, D=0.5M; issued 5M
    state = openProposal(
      state,
      { id: "p-officer", kind: "officer", title: "CEO", rationale: "", proposerDid: A, payload: { office: "CEO", did: A } },
      ROSTER,
    ).state;
    // A alone: 2M yes of 5M — not yet.
    state = castVote(state, "p-officer", A, "yes", ROSTER).state;
    expect(state.proposals.get("p-officer")?.status).toBe("open");
    // C adds 1M → 3M > 2.5M → passes.
    const result = castVote(state, "p-officer", C, "yes", ROSTER);
    expect(result.state.proposals.get("p-officer")?.status).toBe("passed");
    expect(result.state.officers.get("CEO")).toBe(A);
  });

  it("abstentions count as cast: sitting out is voting no", () => {
    let state = incorporated();
    state = openProposal(
      state,
      { id: "p1", kind: "officer", title: "", rationale: "", proposerDid: A, payload: { office: "CEO", did: A } },
      ROSTER,
    ).state;
    // A yes (2M). B, C, D abstain (3M cast). Possible yes = 2M + 0 remaining = 2M ≤ 2.5M → doomed.
    state = castVote(state, "p1", A, "yes", ROSTER).state;
    for (const voter of [B, C, D]) state = castVote(state, "p1", voter, "abstain", ROSTER).state;
    // E through L hold 0 shares — nothing left to cast. 2M is not > 2.5M.
    expect(state.proposals.get("p1")?.status).toBe("failed");
  });

  it("a charter amendment needs 2/3 of issued shares", () => {
    let state = incorporated();
    state = openProposal(
      state,
      { id: "p1", kind: "charter_amendment", title: "", rationale: "", proposerDid: A, payload: { sharesAuthorized: 50_000_000 } },
      ROSTER,
    ).state;
    // A+B = 3.5M of 5M = 70% ≥ 2/3 → passes.
    state = castVote(state, "p1", A, "yes", ROSTER).state;
    const result = castVote(state, "p1", B, "yes", ROSTER);
    expect(result.state.sharesAuthorized).toBe(50_000_000);
  });

  it("changing your vote is legal; only the last counts", () => {
    let state = incorporated();
    state = openProposal(
      state,
      { id: "p1", kind: "officer", title: "", rationale: "", proposerDid: A, payload: { office: "CEO", did: B } },
      ROSTER,
    ).state;
    state = castVote(state, "p1", A, "yes", ROSTER).state; // 2M yes
    state = castVote(state, "p1", A, "no", ROSTER).state; // recast: 2M no, possible yes = 3M... wait
    // After A's recast: yes=0, cast=2M, possible yes = 3M > 2.5M → still open.
    expect(state.proposals.get("p1")?.status).toBe("open");
    state = castVote(state, "p1", B, "yes", ROSTER).state; // 1.5M yes
    const result = castVote(state, "p1", C, "yes", ROSTER); // 2.5M yes — not > 2.5M
    expect(result.state.proposals.get("p1")?.status).toBe("open");
  });
});

describe("the self-dealing rules", () => {
  it("only the CEO may open an equity grant", () => {
    let state = incorporated();
    state = openProposal(
      state,
      { id: "p-ceo", kind: "officer", title: "", rationale: "", proposerDid: A, payload: { office: "CEO", did: A } },
      ROSTER,
    ).state;
    state = castVote(state, "p-ceo", A, "yes", ROSTER).state;
    state = castVote(state, "p-ceo", C, "yes", ROSTER).state; // seats A

    expect(mayOpen(state, "equity_grant", B, ROSTER).ok).toBe(false);
    expect(mayOpen(state, "equity_grant", A, ROSTER).ok).toBe(true);
  });

  it("a CEO self-grant still needs the shareholders it dilutes", () => {
    let state = incorporated();
    state = openProposal(
      state,
      { id: "p-ceo", kind: "officer", title: "", rationale: "", proposerDid: A, payload: { office: "CEO", did: A } },
      ROSTER,
    ).state;
    state = castVote(state, "p-ceo", A, "yes", ROSTER).state;
    state = castVote(state, "p-ceo", C, "yes", ROSTER).state;

    state = openProposal(
      state,
      { id: "p-grab", kind: "equity_grant", title: "", rationale: "", proposerDid: A, payload: { did: A, shares: 1_000_000 } },
      ROSTER,
    ).state;
    // A votes its own grant yes — 2M of 5M is not a majority.
    state = castVote(state, "p-grab", A, "yes", ROSTER).state;
    expect(state.proposals.get("p-grab")?.status).toBe("open");
    // B and D vote no (2M no). Possible yes = 2M + 1M (C) = 3M > 2.5M → still open.
    state = castVote(state, "p-grab", B, "no", ROSTER).state;
    state = castVote(state, "p-grab", D, "no", ROSTER).state;
    expect(state.proposals.get("p-grab")?.status).toBe("open");
    // C abstains → possible yes = 2M ≤ 2.5M → the grab dies.
    const result = castVote(state, "p-grab", C, "abstain", ROSTER);
    expect(result.state.proposals.get("p-grab")?.status).toBe("failed");
    expect(sharesOf(result.state, A)).toBe(2_000_000);
  });

  it("dilution is real: a grant to one shrinks everyone else's percentage", () => {
    let state = incorporated();
    const before = standing(state, B).pct;
    state = openProposal(
      state,
      { id: "p1", kind: "equity_grant", title: "", rationale: "", proposerDid: A, payload: { did: E, shares: 5_000_000 } },
      ROSTER,
    ).state;
    state = castVote(state, "p1", A, "yes", ROSTER).state;
    const result = castVote(state, "p1", C, "yes", ROSTER);
    expect(result.state.proposals.get("p1")?.status).toBe("passed");
    expect(totalIssued(result.state)).toBe(10_000_000);
    expect(standing(result.state, B).pct).toBeLessThan(before);
    expect(standing(result.state, E).pct).toBeCloseTo(0.5);
  });

  it("grants cannot exceed authorized shares", () => {
    const state = incorporated(); // 5M issued of 10M authorized
    const result = openProposal(
      state,
      { id: "p1", kind: "equity_grant", title: "", rationale: "", proposerDid: A, payload: { did: A, shares: 6_000_000 } },
      ROSTER,
    );
    expect(result.ok).toBe(false);
  });
});

describe("expertise: chosen, public, and load-bearing", () => {
  it("declaring needs no vote — a claim takes nothing from anyone", () => {
    const result = declareExpertise(initialCorpState(), A, ["Auth", " billing "], 4);
    expect(result.ok).toBe(true);
    // Normalized so "Auth" and "auth" cannot be two different claims.
    expect(result.accepted).toEqual(["auth", "billing"]);
  });

  it("refuses to let one participant claim everything", () => {
    const result = declareExpertise(initialCorpState(), A, ["a", "b", "c", "d", "e"], 4);
    expect(result.ok).toBe(false);
    expect(result.state.expertise.size).toBe(0);
  });

  it("gates work on declared expertise, so declaring is what makes you valuable", () => {
    let state = incorporated();
    state = declareExpertise(state, K, ["payments"], 4).state;

    // L never declared payments, so the work cannot be routed to them.
    const toOutsider = openProposal(
      state,
      { id: "p1", kind: "work_item", title: "billing", rationale: "", proposerDid: A,
        payload: { title: "billing", assigneeDid: L, requiresExpertise: "payments" } },
      ROSTER,
    );
    expect(toOutsider.ok).toBe(false);

    const toExpert = openProposal(
      state,
      { id: "p2", kind: "work_item", title: "billing", rationale: "", proposerDid: A,
        payload: { title: "billing", assigneeDid: K, requiresExpertise: "Payments" } },
      ROSTER,
    );
    expect(toExpert.ok).toBe(true);
  });
});

describe("offices are invented, not issued", () => {
  it("accepts any office name the group invents", () => {
    let state = incorporated();
    const opened = openProposal(
      state,
      { id: "p1", kind: "officer", title: "", rationale: "", proposerDid: A,
        payload: { office: "Steward of the Treasury", did: B } },
      ROSTER,
    );
    expect(opened.ok).toBe(true);
    state = opened.state;
    state = castVote(state, "p1", A, "yes", ROSTER).state;
    const result = castVote(state, "p1", C, "yes", ROSTER);
    expect(result.state.officers.get("Steward of the Treasury")).toBe(B);
  });

  it("caps how many offices can exist, so a majority cannot mint a title for everyone", () => {
    let state = incorporated();
    for (const [i, name] of ["one", "two", "three"].entries()) {
      const id = `p-${i}`;
      state = openProposal(
        state,
        { id, kind: "officer", title: "", rationale: "", proposerDid: A, payload: { office: name, did: A } },
        ROSTER,
        2,
      ).ok
        ? castVote(
            castVote(
              openProposal(state, { id, kind: "officer", title: "", rationale: "", proposerDid: A, payload: { office: name, did: A } }, ROSTER, 2).state,
              id, A, "yes", ROSTER,
            ).state,
            id, C, "yes", ROSTER,
          ).state
        : state;
    }
    expect(state.officers.size).toBe(2);
  });

  it("rejects an office name that is not a name", () => {
    const result = openProposal(
      incorporated(),
      { id: "p1", kind: "officer", title: "", rationale: "", proposerDid: A, payload: { office: "", did: B } },
      ROSTER,
    );
    expect(result.ok).toBe(false);
  });
});

describe("money cannot be voted into existence", () => {
  it("refuses a budget that creates money", () => {
    // A group could previously vote itself $999,000,000, which made insolvency — and so
    // the entire runway — unreachable.
    const result = openProposal(
      incorporated(),
      { id: "p1", kind: "budget", title: "", rationale: "", proposerDid: A, payload: { delta: 999_000_000 } },
      ROSTER,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("spend");
  });

  it("allows spending", () => {
    expect(
      openProposal(
        incorporated(),
        { id: "p1", kind: "budget", title: "", rationale: "", proposerDid: A, payload: { delta: -50_000 } },
        ROSTER,
      ).ok,
    ).toBe(true);
  });

  it("lets capital in only by dilution", () => {
    let state = incorporated();
    const before = standing(state, A).pct;
    state = openProposal(
      state,
      { id: "p1", kind: "raise", title: "", rationale: "", proposerDid: A, payload: { amount: 500_000, shares: 5_000_000 } },
      ROSTER,
    ).state;
    state = castVote(state, "p1", A, "yes", ROSTER).state;
    state = castVote(state, "p1", C, "yes", ROSTER).state;

    expect(state.treasury).toBe(INITIAL_TREASURY + 500_000);
    // Runway bought with ownership: the same holding is now a smaller share.
    expect(standing(state, A).pct).toBeLessThan(before);
    // Investor shares buy no votes, so a raise cannot manufacture a majority.
    expect(state.shares.has("investors")).toBe(false);
  });

  it("cannot raise beyond the authorized shares", () => {
    expect(
      openProposal(
        incorporated(),
        { id: "p1", kind: "raise", title: "", rationale: "", proposerDid: A, payload: { amount: 1, shares: 99_000_000 } },
        ROSTER,
      ).ok,
    ).toBe(false);
  });
});

describe("scenarios change the purpose, not the power", () => {
  it("removes the kinds a world does not have", () => {
    const result = openProposal(
      incorporated(),
      { id: "p1", kind: "product", title: "", rationale: "", proposerDid: A, payload: { name: "thing" } },
      ROSTER,
      6,
      COMMONS_SCENARIO.withoutKinds,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not exist in this world");
  });

  it("rewards distributed contribution without telling anyone", () => {
    const inflow = COMMONS_SCENARIO.inflow;
    expect(inflow).toBeDefined();
    const one = inflow?.(incorporated(), { contributors: [A, A, A], workCompleted: 3 });
    const three = inflow?.(incorporated(), { contributors: [A, B, C], workCompleted: 3 });
    // Same amount of work; the pool cares how many hands did it.
    expect(three?.amount).toBeGreaterThan((one?.amount ?? 0) * 2);
    expect(inflow?.(incorporated(), { contributors: [], workCompleted: 0 }).amount).toBe(0);
  });

  it("keeps voting power identical across scenarios", () => {
    // The engine is the constant: a scenario cannot alter who wins a vote.
    expect(COMMONS_SCENARIO.withoutKinds).not.toContain("officer");
    expect(COMMONS_SCENARIO.withoutKinds).not.toContain("equity_grant");
  });
});

describe("the clock: payroll, runway, and endings", () => {
  /** Incorporate, then put someone on a salary. */
  function withSalary(salary: number): CorpState {
    let state = incorporated();
    state = openProposal(
      state,
      { id: "p-pay", kind: "comp", title: "", rationale: "", proposerDid: A, payload: { did: A, salary } },
      ROSTER,
    ).state;
    state = castVote(state, "p-pay", A, "yes", ROSTER).state;
    state = castVote(state, "p-pay", C, "yes", ROSTER).state;
    expect(state.comp.get(A)).toBe(salary);
    return state;
  }

  it("debits every voted salary from the shared treasury", () => {
    const state = withSalary(50_000);
    const after = runPayroll(state, true);
    expect(after.state.treasury).toBe(INITIAL_TREASURY - 50_000);
    expect(after.state.payrolls).toBe(1);
  });

  it("a company that pays nobody burns no runway", () => {
    const after = runPayroll(incorporated(), true);
    expect(after.state.treasury).toBe(INITIAL_TREASURY);
  });

  it("ends the run when the treasury cannot meet payroll", () => {
    // A salary the company cannot sustain: solvent for two payrolls, then not.
    let state = withSalary(100_000);
    for (let i = 0; i < 2; i++) state = runPayroll(state, true).state;
    expect(state.outcome).toBeUndefined();
    expect(state.treasury).toBe(50_000);

    const bust = runPayroll(state, true);
    expect(bust.state.outcome?.kind).toBe("insolvent");
    expect(bust.effects.some((e) => e.type === "run_ended")).toBe(true);
  });

  it("takes the treasury and valuation from the ruleset, not a constant", () => {
    // A sprint ruleset asking for a short runway was silently given the default one,
    // so no experiment could actually vary the economics.
    const lean = mergeRuleset({ economy: { initialTreasury: 1_000, initialValuation: 500 } });
    let state = initialCorpState();
    state = openProposal(
      state,
      { id: "p1", kind: "charter", title: "", rationale: "", proposerDid: A, payload: CHARTER },
      ROSTER,
    ).state;
    for (const voter of [A, B, C, D, E, F, G]) {
      state = castVote(state, "p1", voter, "yes", ROSTER, lean).state;
    }
    expect(state.treasury).toBe(1_000);
    expect(state.valuation).toBe(500);
  });

  it("does not run payroll before there is a company", () => {
    const result = runPayroll(initialCorpState(), true);
    expect(result.effects).toHaveLength(0);
  });

  it("stops paying once the run is over", () => {
    const ended = endAtHorizon(incorporated());
    expect(ended.state.outcome?.kind).toBe("horizon");
    // A closed record must not keep moving.
    expect(runPayroll(ended.state, true).effects).toHaveLength(0);
    expect(endAtHorizon(ended.state).effects).toHaveLength(0);
  });

  it("lets the participants wind the company up themselves", () => {
    let state = incorporated();
    state = openProposal(
      state,
      { id: "p-end", kind: "dissolve", title: "wind up", rationale: "", proposerDid: A, payload: { reason: "we are done" } },
      ROSTER,
    ).state;
    state = castVote(state, "p-end", A, "yes", ROSTER).state;
    const result = castVote(state, "p-end", C, "yes", ROSTER);
    expect(result.state.outcome?.kind).toBe("dissolved");
    expect(result.state.outcome?.summary).toContain("we are done");
  });
});

describe("work and the valuation ladder", () => {
  it("a passed work item grants repo.commit to the assignee", () => {
    let state = incorporated();
    state = openProposal(
      state,
      { id: "p-ceo", kind: "officer", title: "", rationale: "", proposerDid: A, payload: { office: "CEO", did: A } },
      ROSTER,
    ).state;
    state = castVote(state, "p-ceo", A, "yes", ROSTER).state;
    state = castVote(state, "p-ceo", C, "yes", ROSTER).state;

    state = openProposal(
      state,
      { id: "p-work", kind: "work_item", title: "build the MVP", rationale: "", proposerDid: A, payload: { title: "build the MVP", assigneeDid: K } },
      ROSTER,
    ).state;
    state = castVote(state, "p-work", A, "yes", ROSTER).state;
    const result = castVote(state, "p-work", B, "yes", ROSTER);
    const grants = result.effects.filter((e) => e.type === "grant");
    expect(grants).toEqual([{ type: "grant", did: K, namespace: "repo.commit" }]);
  });

  it("the first completed work item is the 10x MVP milestone", () => {
    let state = incorporated();
    state = openProposal(
      state,
      { id: "p-work", kind: "work_item", title: "MVP", rationale: "", proposerDid: A, payload: { title: "MVP", assigneeDid: K } },
      ROSTER,
    ).state;
    state = castVote(state, "p-work", A, "yes", ROSTER).state;
    state = castVote(state, "p-work", B, "yes", ROSTER).state;

    const done = completeWork(state, "p-work", K);
    expect(done.ok).toBe(true);
    expect(done.state.valuation).toBe(MVP_VALUATION);
    // Paper wealth moved for every shareholder.
    expect(standing(done.state, A).paperValue).toBe(4_000_000);
  });

  it("only the assignee may submit their work item", () => {
    let state = incorporated();
    state = openProposal(
      state,
      { id: "p-work", kind: "work_item", title: "MVP", rationale: "", proposerDid: A, payload: { title: "MVP", assigneeDid: K } },
      ROSTER,
    ).state;
    state = castVote(state, "p-work", A, "yes", ROSTER).state;
    state = castVote(state, "p-work", B, "yes", ROSTER).state;

    expect(completeWork(state, "p-work", L).ok).toBe(false);
    const done = completeWork(state, "p-work", K);
    expect(done.ok).toBe(true);
    // No double-submit: against the returned state, the item is already complete.
    expect(completeWork(done.state, "p-work", K).ok).toBe(false);
  });
});
