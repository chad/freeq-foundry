import { describe, expect, it } from "vitest";
import {
  EventTypes,
  capabilitiesProjector,
  constitutionProjector,
  participantsProjector,
  project,
  proposalsProjector,
  type ConstitutionRule,
  type ProposalOpenedPayload,
} from "@freeq-foundry/projections";
import {
  GENESIS_HASH,
  attestPositionAndRecord,
  deterministicKeyPair,
  type Digest,
  type DraftEvent,
  type RecordedEvent,
} from "@freeq-foundry/protocol";
import {
  decideElection,
  evaluateQuorum,
  eligibleVoters,
  tallyProposal,
  type Ballot,
  type Candidate,
} from "./tally.js";
import {
  GENESIS_CONSTITUTION,
  executeProposal,
  genesisRules,
  policyExpression,
  validateProposal,
} from "./execute.js";

const recorder = deterministicKeyPair("recorder");
const controller = deterministicKeyPair("controller");

class Log {
  readonly events: RecordedEvent[] = [];
  #t = 0;
  #prev: Digest = GENESIS_HASH;
  readonly #seq = new Map<string, number>();

  add(eventType: string, payload: unknown, actorDid = controller.did): void {
    const key = actorDid;
    const sequence = (this.#seq.get(key) ?? 0) + 1;
    this.#seq.set(key, sequence);
    const draft: DraftEvent = {
      eventId: `e-${this.#t}`,
      runId: "run-gov",
      eventType,
      schemaVersion: 1,
      actorDid,
      participantType: "agent",
      participantSequence: sequence,
      wallTime: new Date(Date.UTC(2026, 0, 1) + this.#t * 1000).toISOString(),
      payload,
      visibility: { type: "public" },
      references: [],
      provenance: {
        signerDid: actorDid,
        terminalHumanDids: [actorDid],
        provenancePathHashes: [],
        admissionCredentialId: "adm",
        directInstructionEventIds: [],
        governanceAuthorizationIds: [],
        capabilityGrantIds: [],
      },
    };
    // Signed by the controller regardless of actorDid: these tests exercise
    // projections and governance logic, not attestation, which has its own suite.
    const event = attestPositionAndRecord(
      draft,
      { logicalTime: this.#t, previousEventHash: this.#prev },
      controller.privateKey,
      recorder.privateKey,
    );
    this.events.push(event);
    this.#t++;
    this.#prev = event.eventHash;
  }

  admit(did: string, lineage: string): void {
    this.add(EventTypes.PARTICIPANT_ADMITTED, {
      did,
      participantType: "agent",
      admissionCredentialId: `adm-${did}`,
      terminalHumanDids: [`root-${lineage}`],
      lineageDepth: 1,
      lineagePseudonym: lineage,
    });
  }

  vote(proposalId: string, voterDid: string, choice: "yes" | "no" | "abstain"): void {
    this.add(EventTypes.VOTE_CAST, { proposalId, choice: { type: choice } }, voterDid);
  }

  state() {
    return {
      constitution: project(constitutionProjector, this.events, "run-gov").state,
      capabilities: project(capabilitiesProjector, this.events, "run-gov").state,
      participants: project(participantsProjector, this.events, "run-gov").state,
      proposals: project(proposalsProjector, this.events, "run-gov").state,
    };
  }
}

const proposal = (overrides: Partial<ProposalOpenedPayload> = {}): ProposalOpenedPayload => ({
  proposalId: "p1",
  kind: "capability_grant",
  title: "Grant commit access to Alice",
  rationale: "Someone must be able to commit code.",
  actions: [
    { type: "grant_capability", toDid: "did:key:zAlice", namespace: "repo.commit" },
  ],
  closesAtLogicalTime: 100,
  ...overrides,
});

describe("genesis constitution", () => {
  it("is deliberately thin", () => {
    // §5.1 withholds a complete constitution. Handing agents a working one would
    // answer the research question by assumption.
    expect(GENESIS_CONSTITUTION.rules.length).toBeLessThanOrEqual(4);
    expect(GENESIS_CONSTITUTION.rules.some((r) => r.kind === "quorum")).toBe(true);
  });

  it("hashes every rule expression, so amendments are diffable", () => {
    for (const rule of genesisRules()) {
      expect(rule.expression.sourceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });
});

describe("tallying", () => {
  const setUp = (): Log => {
    const log = new Log();
    log.admit("did:key:zAlice", "L1");
    log.admit("did:key:zBob", "L2");
    log.admit("did:key:zCarol", "L1");
    log.add(EventTypes.PROPOSAL_OPENED, proposal());
    return log;
  };

  it("counts yes, no, and abstain", () => {
    const log = setUp();
    log.vote("p1", "did:key:zAlice", "yes");
    log.vote("p1", "did:key:zBob", "no");
    log.vote("p1", "did:key:zCarol", "abstain");

    const s = log.state();
    const tally = tallyProposal(s.proposals.byId.get("p1") as never, s.participants);
    expect(tally).toMatchObject({ yes: 1, no: 1, abstain: 1, eligibleVoters: 3 });
  });

  it("counts distinct lineages among yes votes separately", () => {
    // Lineage quorums measure who agreed, not who showed up.
    const log = setUp();
    log.vote("p1", "did:key:zAlice", "yes");
    log.vote("p1", "did:key:zCarol", "yes"); // same lineage as Alice
    log.vote("p1", "did:key:zBob", "no");

    const s = log.state();
    const tally = tallyProposal(s.proposals.byId.get("p1") as never, s.participants);
    expect(tally.yes).toBe(2);
    expect(tally.yesLineages).toBe(1);
    expect(tally.distinctLineages).toBe(2);
  });

  it("excludes a suspended participant's vote", () => {
    const log = setUp();
    log.vote("p1", "did:key:zAlice", "yes");
    log.add(EventTypes.PARTICIPANT_SUSPENDED, {
      did: "did:key:zAlice",
      reasonCode: "revoked",
    });

    const s = log.state();
    const tally = tallyProposal(s.proposals.byId.get("p1") as never, s.participants);
    expect(tally.yes).toBe(0);
    expect(tally.eligibleVoters).toBe(2);
  });

  it("does not count an election-style choice as a proposal vote", () => {
    // Counting an approval ballot as a yes would silently distort a tally.
    const log = setUp();
    log.add(
      EventTypes.VOTE_CAST,
      { proposalId: "p1", choice: { type: "approval", candidateIds: ["c1"] } },
      "did:key:zAlice",
    );
    const s = log.state();
    const tally = tallyProposal(s.proposals.byId.get("p1") as never, s.participants);
    expect(tally.yes).toBe(0);
  });

  it("computes integer percentages, since floats are forbidden in payloads", () => {
    const log = setUp();
    log.vote("p1", "did:key:zAlice", "yes");
    log.vote("p1", "did:key:zBob", "yes");
    log.vote("p1", "did:key:zCarol", "no");
    const s = log.state();
    const tally = tallyProposal(s.proposals.byId.get("p1") as never, s.participants);
    expect(tally.yesSharePct).toBe(67);
    expect(Number.isInteger(tally.yesSharePct)).toBe(true);
  });

  it("excludes the controller and evaluator from the electorate", () => {
    const log = new Log();
    log.admit("did:key:zAlice", "L1");
    log.add(EventTypes.PARTICIPANT_ADMITTED, {
      did: "did:key:zCtl",
      participantType: "controller",
      admissionCredentialId: "a",
      terminalHumanDids: ["r"],
      lineageDepth: 0,
      lineagePseudonym: "L0",
    });
    expect(eligibleVoters(log.state().participants)).toBe(1);
  });
});

describe("quorum", () => {
  const tally = (overrides = {}) => ({
    yes: 3,
    no: 1,
    abstain: 0,
    eligibleVoters: 4,
    distinctLineages: 3,
    yesLineages: 3,
    yesSharePct: 75,
    turnoutPct: 100,
    ...overrides,
  });

  it("passes when every rule is met", () => {
    expect(evaluateQuorum(genesisRules(), tally(), 10).passed).toBe(true);
  });

  it("fails when any rule is unmet, and names it", () => {
    // Conjunctive across the constitution: adding a rule should tighten
    // governance, never loosen it.
    const outcome = evaluateQuorum(genesisRules(), tally({ turnoutPct: 25 }), 10);
    expect(outcome.passed).toBe(false);
    expect(outcome.ruleId).toBe("genesis.turnout");
  });

  it("fails a single-lineage majority", () => {
    // One operator's agents should not carry a proposal alone.
    const outcome = evaluateQuorum(
      genesisRules(),
      tally({ yesLineages: 1 }),
      10,
    );
    expect(outcome.passed).toBe(false);
  });

  it("fails when no quorum rule is in force", () => {
    // An organization that has not said how decisions are made has not
    // authorized any.
    const outcome = evaluateQuorum([], tally(), 10);
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("no decision procedure exists");
  });

  it("ignores non-quorum rules", () => {
    const eligibility: ConstitutionRule = {
      id: "x",
      kind: "eligibility",
      description: "unrelated",
      expression: policyExpression("nonexistent.attribute = 1"),
    };
    expect(evaluateQuorum([...genesisRules(), eligibility], tally(), 10).passed).toBe(true);
  });
});

describe("proposal validation", () => {
  const context = () => {
    const log = new Log();
    log.admit("did:key:zAlice", "L1");
    log.admit("did:key:zBob", "L2");
    log.add(EventTypes.CONSTITUTION_ADOPTED, {
      constitutionId: "genesis",
      version: 1,
      rules: genesisRules(),
    });
    return { log, ...log.state(), proposerDid: "did:key:zAlice", atLogicalTime: 10 };
  };

  it("accepts a well-formed proposal", () => {
    expect(validateProposal(proposal(), context()).valid).toBe(true);
  });

  it("rejects a proposal with no actions", () => {
    // Governance must have consequences (§6.6).
    const result = validateProposal(proposal({ actions: [] }), context());
    expect(result.problems.join()).toContain("at least one executable action");
  });

  it("rejects a close time in the past", () => {
    const result = validateProposal(proposal({ closesAtLogicalTime: 5 }), context());
    expect(result.problems.join()).toContain("not in the future");
  });

  it("rejects an unadmitted proposer", () => {
    const ctx = { ...context(), proposerDid: "did:key:zStranger" };
    expect(validateProposal(proposal(), ctx).problems.join()).toContain(
      "not an admitted participant",
    );
  });

  it("rejects a grant to a non-participant", () => {
    const result = validateProposal(
      proposal({
        actions: [
          { type: "grant_capability", toDid: "did:key:zGhost", namespace: "repo.commit" },
        ],
      }),
      context(),
    );
    expect(result.problems.join()).toContain("not an admitted participant");
  });

  it("rejects an unknown capability namespace", () => {
    const result = validateProposal(
      proposal({
        actions: [
          { type: "grant_capability", toDid: "did:key:zAlice", namespace: "nuclear.launch" },
        ],
      }),
      context(),
    );
    expect(result.problems.join()).toContain("unknown capability namespace");
  });

  it("rejects an amendment touching an environmental rule", () => {
    // The immutable boundary (§15.5, §6.7). Participants may govern themselves
    // but cannot vote away provenance or the evaluator.
    const result = validateProposal(
      proposal({
        kind: "constitution_amendment",
        actions: [
          { type: "amend_constitution", removeRuleIds: ["environment.evaluator_external"] },
        ],
      }),
      context(),
    );
    expect(result.problems.join()).toContain("environmental and cannot be amended");
  });

  it("rejects an amendment removing an entrenched rule by ordinary process", () => {
    const ctx = context();
    ctx.log.add(EventTypes.CONSTITUTION_ADOPTED, {
      constitutionId: "genesis",
      version: 2,
      rules: [
        ...genesisRules(),
        {
          id: "entrenched.rule",
          kind: "quorum",
          description: "hard to change",
          expression: policyExpression("proposal.yes_share_pct > 66"),
          entrenched: true,
        },
      ],
    });
    const result = validateProposal(
      proposal({
        kind: "constitution_amendment",
        actions: [{ type: "amend_constitution", removeRuleIds: ["entrenched.rule"] }],
      }),
      { ...ctx, ...ctx.log.state() },
    );
    expect(result.problems.join()).toContain("entrenched");
  });

  it("rejects an unknown attribute in a rule expression", () => {
    // Caught here rather than at evaluation, where it would deny forever and
    // look like a permissions bug.
    const result = validateProposal(
      proposal({
        kind: "constitution_amendment",
        actions: [
          {
            type: "amend_constitution",
            addRules: [
              {
                id: "new.rule",
                kind: "quorum",
                description: "typo",
                expression: policyExpression("proposal.yes_shrae_pct > 50"),
              },
            ],
          },
        ],
      }),
      context(),
    );
    expect(result.problems.join()).toContain("unknown attribute");
  });

  it("rejects a cited constitutional basis that is not in force", () => {
    const result = validateProposal(
      proposal({ constitutionalBasis: "no.such.rule" }),
      context(),
    );
    expect(result.problems.join()).toContain("not a rule in force");
  });

  it("rejects a dependency on a failed proposal", () => {
    const ctx = context();
    ctx.log.add(EventTypes.PROPOSAL_OPENED, proposal({ proposalId: "p0" }));
    ctx.log.add(EventTypes.PROPOSAL_CLOSED, {
      proposalId: "p0",
      outcome: "failed",
      tally: { yes: 0, no: 1, abstain: 0, eligibleVoters: 2, distinctLineages: 1 },
      reason: "rejected",
    });
    const result = validateProposal(
      proposal({ dependsOn: ["p0"] }),
      { ...ctx, ...ctx.log.state() },
    );
    expect(result.problems.join()).toContain("which failed");
  });

  it("rejects a non-integer budget allocation", () => {
    const result = validateProposal(
      proposal({
        actions: [{ type: "allocate_budget", toDid: "did:key:zAlice", credits: 10.5 }],
      }),
      context(),
    );
    expect(result.problems.join()).toContain("integer");
  });
});

describe("execution", () => {
  const context = () => {
    const log = new Log();
    log.admit("did:key:zAlice", "L1");
    log.admit("did:key:zBob", "L2");
    log.add(EventTypes.CONSTITUTION_ADOPTED, {
      constitutionId: "genesis",
      version: 1,
      rules: genesisRules(),
    });
    return { log, ...log.state(), proposerDid: "did:key:zAlice", atLogicalTime: 10 };
  };

  it("produces effects for a valid proposal", () => {
    const result = executeProposal(proposal(), context());
    expect(result.executed).toBe(true);
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({
      kind: "grant_capability",
      toDid: "did:key:zAlice",
      namespace: "repo.commit",
    });
  });

  it("is transactional: nothing applies if anything is invalid", () => {
    // A half-executed proposal would leave the organization in a state nobody
    // voted for.
    const result = executeProposal(
      proposal({
        actions: [
          { type: "grant_capability", toDid: "did:key:zAlice", namespace: "repo.commit" },
          { type: "grant_capability", toDid: "did:key:zGhost", namespace: "repo.merge" },
        ],
      }),
      context(),
    );
    expect(result.executed).toBe(false);
    expect(result.effects).toEqual([]);
  });

  it("revalidates, because state can change between passage and execution", () => {
    // Passage authorized the intent, not a stale plan.
    const ctx = context();
    ctx.log.add(EventTypes.PARTICIPANT_SUSPENDED, {
      did: "did:key:zAlice",
      reasonCode: "revoked",
    });
    const result = executeProposal(proposal(), { ...ctx, ...ctx.log.state() });
    expect(result.executed).toBe(false);
    expect(result.reason).toContain("suspended");
  });

  it("bumps the constitution version on amendment", () => {
    const result = executeProposal(
      proposal({
        kind: "constitution_amendment",
        actions: [
          {
            type: "amend_constitution",
            addRules: [
              {
                id: "new.quorum",
                kind: "quorum",
                description: "supermajority",
                expression: policyExpression("proposal.yes_share_pct > 66"),
              },
            ],
          },
        ],
      }),
      context(),
    );
    expect(result.executed).toBe(true);
    const effect = result.effects[0] as { kind: string; version: number; rules: unknown[] };
    expect(effect.kind).toBe("adopt_constitution");
    expect(effect.version).toBe(2);
    expect(effect.rules).toHaveLength(genesisRules().length + 1);
  });

  it("gives each granted capability a distinct id", () => {
    const result = executeProposal(
      proposal({
        actions: [
          { type: "grant_capability", toDid: "did:key:zAlice", namespace: "repo.commit" },
          { type: "grant_capability", toDid: "did:key:zBob", namespace: "repo.review" },
        ],
      }),
      context(),
    );
    const ids = result.effects.map((e) => (e as { grantId: string }).grantId);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("elections", () => {
  const candidate = (
    id: string,
    did: string,
    nominatedAt = 0,
    officesHeld = 0,
  ): Candidate => ({ candidateId: id, did, nominatedAtLogicalTime: nominatedAt, officesHeld });

  const ballot = (voterDid: string, ...candidateIds: string[]): Ballot => ({
    voterDid,
    candidateIds,
  });

  it("decides plurality by first preference", () => {
    const outcome = decideElection(
      "plurality",
      [candidate("a", "did:key:zA"), candidate("b", "did:key:zB")],
      [ballot("v1", "a"), ballot("v2", "a"), ballot("v3", "b")],
      ["lowest_did"],
    );
    expect(outcome.winnerId).toBe("a");
  });

  it("decides approval by total approvals", () => {
    const outcome = decideElection(
      "approval",
      [candidate("a", "did:key:zA"), candidate("b", "did:key:zB")],
      [ballot("v1", "a", "b"), ballot("v2", "b")],
      ["lowest_did"],
    );
    expect(outcome.winnerId).toBe("b");
  });

  it("does not count a duplicate approval twice", () => {
    const outcome = decideElection(
      "approval",
      [candidate("a", "did:key:zA"), candidate("b", "did:key:zB")],
      [ballot("v1", "a", "a"), ballot("v2", "b"), ballot("v3", "b")],
      ["lowest_did"],
    );
    expect(outcome.winnerId).toBe("b");
  });

  it("applies tie-breaks in order and records which was used", () => {
    // The result must be auditable, so the tie-break is part of the outcome.
    const outcome = decideElection(
      "approval",
      [candidate("a", "did:key:zB", 5), candidate("b", "did:key:zA", 2)],
      [ballot("v1", "a"), ballot("v2", "b")],
      ["earliest_nomination", "lowest_did"],
    );
    expect(outcome.winnerId).toBe("b");
    expect(outcome.tieBreakUsed).toBe("earliest_nomination");
  });

  it("falls through to the next tie-break when one does not resolve", () => {
    const outcome = decideElection(
      "approval",
      [candidate("a", "did:key:zB", 5), candidate("b", "did:key:zA", 5)],
      [ballot("v1", "a"), ballot("v2", "b")],
      ["earliest_nomination", "lowest_did"],
    );
    expect(outcome.tieBreakUsed).toBe("lowest_did");
    expect(outcome.winnerId).toBe("b");
  });

  it("always resolves a tie, even with no tie-breaks configured", () => {
    // A tie must resolve. Returning no winner would deadlock the organization by
    // coincidence.
    const outcome = decideElection(
      "approval",
      [candidate("a", "did:key:zB"), candidate("b", "did:key:zA")],
      [ballot("v1", "a"), ballot("v2", "b")],
      [],
    );
    expect(outcome.winnerId).toBeDefined();
    expect(outcome.tieBreakUsed).toBe("lowest_did");
  });

  it("is deterministic, which replay requires", () => {
    const candidates = [candidate("a", "did:key:zA"), candidate("b", "did:key:zB")];
    const ballots = [ballot("v1", "a"), ballot("v2", "b")];
    const first = decideElection("approval", candidates, ballots, ["lowest_did"]);
    const second = decideElection("approval", candidates, ballots, ["lowest_did"]);
    expect(first.winnerId).toBe(second.winnerId);
  });

  it("runs a ranked runoff to a majority", () => {
    const outcome = decideElection(
      "ranked_runoff",
      [candidate("a", "did:key:zA"), candidate("b", "did:key:zB"), candidate("c", "did:key:zC")],
      [
        ballot("v1", "a", "c"),
        ballot("v2", "a", "c"),
        ballot("v3", "b", "c"),
        ballot("v4", "b", "c"),
        ballot("v5", "c", "a"),
      ],
      ["lowest_did"],
    );
    expect(outcome.winnerId).toBeDefined();
    expect(outcome.rounds).toBeGreaterThanOrEqual(1);
  });

  it("terminates when every remaining candidate ties", () => {
    // Eliminating all tied-last candidates at once could empty the set.
    const outcome = decideElection(
      "ranked_runoff",
      [candidate("a", "did:key:zA"), candidate("b", "did:key:zB")],
      [ballot("v1", "a"), ballot("v2", "b")],
      ["lowest_did"],
    );
    expect(outcome.winnerId).toBeDefined();
  });

  it("reports no winner when nobody was nominated", () => {
    const outcome = decideElection("approval", [], [], ["lowest_did"]);
    expect(outcome.winnerId).toBeUndefined();
    expect(outcome.reason).toContain("no candidates");
  });

  it("ignores ballots for unknown candidates", () => {
    const outcome = decideElection(
      "approval",
      [candidate("a", "did:key:zA")],
      [ballot("v1", "ghost"), ballot("v2", "a")],
      ["lowest_did"],
    );
    expect(outcome.winnerId).toBe("a");
    expect(outcome.scores.get("a")).toBe(1);
  });
});
