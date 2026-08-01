import {
  DEFAULT_HORIZON_MS,
  RunTerminationReason,
  RunValidity,
  attestPositionAndRecord,
  deterministicKeyPair,
  GENESIS_HASH,
  type Digest,
  type DraftEvent,
  type RecordedEvent,
} from "@freeq-foundry/protocol";
import { describe, expect, it } from "vitest";
import {
  EventTypes,
  categoryOf,
  type ConstitutionRule,
} from "./events.js";
import {
  activeGrantsFor,
  activeRules,
  activityProjector,
  authorityConcentration,
  autonomyDisagreements,
  capabilitiesProjector,
  constitutionProjector,
  coreProjectors,
  distinctLineages,
  elapsedRunClockMs,
  governanceCostShare,
  governanceOverhead,
  outcomeProjector,
  participantsProjector,
  proposalsProjector,
  remainingCredits,
  runProjector,
  treasuryProjector,
} from "./core.js";
import { forEventTypes, project, projectAll, resume } from "./projector.js";

const recorder = deterministicKeyPair("recorder");
const controller = deterministicKeyPair("controller");
const HOUR = 60 * 60 * 1000;
const GENESIS_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

/** Builds a chained run of arbitrary events, for projection tests. */
class Log {
  readonly events: RecordedEvent[] = [];
  #logicalTime = 0;
  #previous: Digest = GENESIS_HASH;
  readonly #sequences = new Map<string, number>();

  add(
    eventType: string,
    payload: unknown,
    options: {
      readonly actor?: ReturnType<typeof deterministicKeyPair>;
      readonly atMs?: number;
      readonly instructed?: boolean;
    } = {},
  ): RecordedEvent {
    const actor = options.actor ?? controller;
    const sequence = (this.#sequences.get(actor.did) ?? 0) + 1;
    this.#sequences.set(actor.did, sequence);

    const draft: DraftEvent = {
      eventId: `e-${this.#logicalTime}`,
      runId: "run-proj",
      eventType,
      schemaVersion: 1,
      actorDid: actor.did,
      participantType: "agent",
      participantSequence: sequence,
      wallTime: new Date(options.atMs ?? GENESIS_MS + this.#logicalTime * 1000).toISOString(),
      payload,
      visibility: { type: "public" },
      references: [],
      provenance: {
        signerDid: actor.did,
        terminalHumanDids: [actor.did],
        provenancePathHashes: [],
        admissionCredentialId: "adm-1",
        directInstructionEventIds: options.instructed === true ? ["instr-1"] : [],
        governanceAuthorizationIds: [],
        capabilityGrantIds: [],
      },
    };

    const event = attestPositionAndRecord(
      draft,
      { logicalTime: this.#logicalTime, previousEventHash: this.#previous },
      actor.privateKey,
      recorder.privateKey,
    );
    this.events.push(event);
    this.#logicalTime++;
    this.#previous = event.eventHash;
    return event;
  }
}

describe("projector mechanics", () => {
  it("folds events in order and records its position", () => {
    const log = new Log();
    log.add(EventTypes.MESSAGE_POSTED, { channelId: "g", text: "a" });
    log.add(EventTypes.MESSAGE_POSTED, { channelId: "g", text: "b" });

    const snapshot = project(activityProjector, log.events, "run-proj");
    expect(snapshot.state.total).toBe(2);
    expect(snapshot.logicalTime).toBe(1);
    expect(snapshot.projectorVersion).toBe(activityProjector.version);
  });

  it("reports -1 for an empty projection rather than 0", () => {
    // 0 is a real logical time. Conflating "nothing applied" with "applied event
    // zero" would make resume skip the genesis event.
    expect(project(activityProjector, [], "run-proj").logicalTime).toBe(-1);
  });

  it("is pure: the same events always give the same state", () => {
    const log = new Log();
    log.add(EventTypes.MESSAGE_POSTED, { channelId: "g", text: "a" });
    expect(project(activityProjector, log.events, "run-proj").state).toEqual(
      project(activityProjector, log.events, "run-proj").state,
    );
  });

  it("resumes from a snapshot without reapplying", () => {
    const log = new Log();
    log.add(EventTypes.MESSAGE_POSTED, { channelId: "g", text: "a" });
    const snapshot = project(activityProjector, log.events, "run-proj");
    log.add(EventTypes.MESSAGE_POSTED, { channelId: "g", text: "b" });

    const resumed = resume(activityProjector, snapshot, log.events);
    expect(resumed.state.total).toBe(2);
    expect(resumed.logicalTime).toBe(1);
  });

  it("refuses a snapshot from a different projector version", () => {
    // Applying new logic to state built by old logic yields something that is
    // neither (§34.3).
    const snapshot = project(activityProjector, [], "run-proj");
    expect(() =>
      resume({ ...activityProjector, version: 2 }, snapshot, []),
    ).toThrow(/rebuild from the log/);
  });

  it("refuses a snapshot from a different projector", () => {
    const snapshot = project(activityProjector, [], "run-proj");
    expect(() => resume(runProjector as never, snapshot as never, [])).toThrow(
      /snapshot is for projector/,
    );
  });

  it("runs several projectors in one pass", () => {
    // One pass matters for consistency: separate passes could observe different
    // suffixes and produce projections that never simultaneously existed.
    const log = new Log();
    log.add(EventTypes.RUN_STARTED, {
      scenarioId: "s",
      epoch: {},
      horizonMs: DEFAULT_HORIZON_MS,
      evaluatorDid: "did:key:zEval",
      confirmatory: true,
      manifestHash: `sha256:${"a".repeat(64)}`,
    });
    log.add(EventTypes.MESSAGE_POSTED, { channelId: "g", text: "hi" });

    const snapshots = projectAll(coreProjectors as never, log.events, "run-proj");
    expect(snapshots.size).toBe(coreProjectors.length);
    for (const snapshot of snapshots.values()) {
      expect(snapshot.logicalTime).toBe(1);
    }
  });

  it("filters by event type when asked", () => {
    const log = new Log();
    log.add(EventTypes.MESSAGE_POSTED, {});
    log.add(EventTypes.VOTE_CAST, { proposalId: "p" });

    const filtered = forEventTypes(activityProjector, [EventTypes.MESSAGE_POSTED]);
    expect(project(filtered, log.events, "run-proj").state.total).toBe(1);
  });

  it("derives a category from the event type prefix", () => {
    expect(categoryOf(EventTypes.PROPOSAL_OPENED)).toBe("governance");
    expect(categoryOf(EventTypes.RELEASE_VERIFIED)).toBe("evaluation");
    expect(categoryOf("")).toBe("");
  });
});

describe("run projection", () => {
  const start = (log: Log): void => {
    log.add(
      EventTypes.RUN_STARTED,
      {
        scenarioId: "webhook-saas-v1",
        epoch: { scenarioVersion: "1" },
        horizonMs: DEFAULT_HORIZON_MS,
        evaluatorDid: "did:key:zEval",
        confirmatory: true,
        manifestHash: `sha256:${"a".repeat(64)}`,
      },
      { atMs: GENESIS_MS },
    );
  };

  it("records the genesis time and manifest", () => {
    const log = new Log();
    start(log);
    const state = project(runProjector, log.events, "run-proj").state;
    expect(state.started).toBe(true);
    expect(state.genesisWallTimeMs).toBe(GENESIS_MS);
    expect(state.confirmatory).toBe(true);
    expect(state.horizonMs).toBe(DEFAULT_HORIZON_MS);
  });

  it("computes the run clock net of pauses", () => {
    const log = new Log();
    start(log);
    log.add(EventTypes.RUN_CLOCK_PAUSED, { reason: "provider outage" }, {
      atMs: GENESIS_MS + 1 * HOUR,
    });
    log.add(EventTypes.RUN_CLOCK_RESUMED, {}, { atMs: GENESIS_MS + 2 * HOUR });
    log.add(EventTypes.MESSAGE_POSTED, {}, { atMs: GENESIS_MS + 4 * HOUR });

    expect(elapsedRunClockMs(project(runProjector, log.events, "run-proj").state)).toBe(
      3 * HOUR,
    );
  });

  it("measures time to release on the run clock, not wall time", () => {
    // The distinction the research protocol depends on (ADR-0009).
    const log = new Log();
    start(log);
    log.add(EventTypes.RUN_CLOCK_PAUSED, { reason: "outage" }, { atMs: GENESIS_MS + 1 * HOUR });
    log.add(EventTypes.RUN_CLOCK_RESUMED, {}, { atMs: GENESIS_MS + 3 * HOUR });
    log.add(
      EventTypes.RELEASE_VERIFIED,
      {
        releaseId: "r1",
        mandatoryTestsPassed: 5,
        mandatoryTestsTotal: 5,
        acceptanceFraction: "1",
        minimumOperatingPeriodMet: true,
        evaluatorSignature: "sig",
      },
      { atMs: GENESIS_MS + 5 * HOUR },
    );

    const state = project(runProjector, log.events, "run-proj").state;
    expect(state.timeToReleaseMs).toBe(3 * HOUR); // 5h wall, 2h paused
  });

  it("keeps only the first release, since the outcome is time-to-first", () => {
    const log = new Log();
    start(log);
    const verified = {
      releaseId: "r1",
      mandatoryTestsPassed: 5,
      mandatoryTestsTotal: 5,
      acceptanceFraction: "1",
      minimumOperatingPeriodMet: true,
      evaluatorSignature: "sig",
    };
    log.add(EventTypes.RELEASE_VERIFIED, verified, { atMs: GENESIS_MS + 2 * HOUR });
    log.add(EventTypes.RELEASE_VERIFIED, verified, { atMs: GENESIS_MS + 6 * HOUR });
    expect(project(runProjector, log.events, "run-proj").state.timeToReleaseMs).toBe(
      2 * HOUR,
    );
  });

  it("ignores a resume with no matching pause rather than inventing one", () => {
    const log = new Log();
    start(log);
    log.add(EventTypes.RUN_CLOCK_RESUMED, {}, { atMs: GENESIS_MS + 1 * HOUR });
    log.add(EventTypes.MESSAGE_POSTED, {}, { atMs: GENESIS_MS + 2 * HOUR });
    expect(elapsedRunClockMs(project(runProjector, log.events, "run-proj").state)).toBe(
      2 * HOUR,
    );
  });

  it("tracks validity and the first evaluation, for the blindness check", () => {
    const log = new Log();
    start(log);
    log.add(EventTypes.RELEASE_SUBMITTED, { releaseId: "r1" });
    log.add(EventTypes.RUN_VALIDITY_JUDGED, {
      validity: RunValidity.INVALID_HARNESS_DEFECT,
      reasonCode: "sandbox_crash",
    });

    const state = project(runProjector, log.events, "run-proj").state;
    expect(state.validity).toBe(RunValidity.INVALID_HARNESS_DEFECT);
    // The judgement postdates evaluation, which is exactly what the blindness
    // check exists to catch.
    expect(state.firstEvaluationLogicalTime).toBeLessThan(
      state.validityJudgedAtLogicalTime as number,
    );
  });

  it("records termination", () => {
    const log = new Log();
    start(log);
    log.add(EventTypes.RUN_TERMINATED, {
      reason: RunTerminationReason.ORGANIZATIONAL_DEADLOCK,
    });
    const state = project(runProjector, log.events, "run-proj").state;
    expect(state.terminated).toBe(true);
    expect(state.terminationReason).toBe(RunTerminationReason.ORGANIZATIONAL_DEADLOCK);
  });
});

describe("participants projection", () => {
  const admit = (
    log: Log,
    label: string,
    roots: readonly string[],
    autonomy?: "autonomous" | "supervised" | "teleoperated",
  ): void => {
    log.add(EventTypes.PARTICIPANT_ADMITTED, {
      did: deterministicKeyPair(label).did,
      participantType: "agent",
      admissionCredentialId: `adm-${label}`,
      terminalHumanDids: roots,
      lineageDepth: 1,
      lineagePseudonym: `pseudo-${roots[0] ?? "none"}`,
      ...(autonomy === undefined ? {} : { declaredAutonomy: autonomy }),
    });
  };

  it("admits and suspends", () => {
    const log = new Log();
    admit(log, "alice", ["did:key:zRootA"]);
    const alice = deterministicKeyPair("alice").did;
    log.add(EventTypes.PARTICIPANT_SUSPENDED, { did: alice, reasonCode: "revoked" });

    const state = project(participantsProjector, log.events, "run-proj").state;
    expect(state.byDid.get(alice)?.suspended).toBe(true);
  });

  it("counts distinct lineages among active participants only", () => {
    const log = new Log();
    admit(log, "alice", ["did:key:zRootA"]);
    admit(log, "bob", ["did:key:zRootB"]);
    admit(log, "carol", ["did:key:zRootA"]); // shares Alice's root

    let state = project(participantsProjector, log.events, "run-proj").state;
    expect(distinctLineages(state)).toBe(2);

    log.add(EventTypes.PARTICIPANT_SUSPENDED, {
      did: deterministicKeyPair("bob").did,
      reasonCode: "revoked",
    });
    state = project(participantsProjector, log.events, "run-proj").state;
    expect(distinctLineages(state)).toBe(1);
  });

  it("measures autonomy rather than trusting the declaration", () => {
    // §58.5: a teleoperated agent counted as autonomous corrupts every claim
    // about model behaviour, so the declaration is checked against evidence.
    const log = new Log();
    admit(log, "alice", ["did:key:zRootA"], "autonomous");
    const alice = deterministicKeyPair("alice");
    for (let i = 0; i < 4; i++) {
      log.add(EventTypes.MESSAGE_POSTED, {}, { actor: alice, instructed: true });
    }

    const state = project(participantsProjector, log.events, "run-proj").state;
    const disagreements = autonomyDisagreements(state);
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0]?.instructedShare).toBeGreaterThan(0.5);
  });

  it("reports no disagreement for a genuinely autonomous agent", () => {
    const log = new Log();
    admit(log, "alice", ["did:key:zRootA"], "autonomous");
    const alice = deterministicKeyPair("alice");
    for (let i = 0; i < 4; i++) {
      log.add(EventTypes.MESSAGE_POSTED, {}, { actor: alice });
    }
    expect(
      autonomyDisagreements(project(participantsProjector, log.events, "run-proj").state),
    ).toEqual([]);
  });
});

describe("constitution projection", () => {
  const rule = (id: string, sunset?: number): ConstitutionRule => ({
    id,
    kind: "quorum",
    description: `rule ${id}`,
    expression: {
      language: "freeq-rules-v1",
      source: "proposal.distinct_lineages >= 2",
      sourceHash: `sha256:${"a".repeat(64)}`,
    },
    ...(sunset === undefined ? {} : { sunsetAtLogicalTime: sunset }),
  });

  it("adopts a constitution and counts amendments", () => {
    const log = new Log();
    log.add(EventTypes.CONSTITUTION_ADOPTED, {
      constitutionId: "c1",
      version: 1,
      rules: [rule("r1")],
    });
    log.add(EventTypes.CONSTITUTION_ADOPTED, {
      constitutionId: "c1",
      version: 2,
      rules: [rule("r1"), rule("r2")],
    });

    const state = project(constitutionProjector, log.events, "run-proj").state;
    expect(state.version).toBe(2);
    expect(state.rules.size).toBe(2);
    expect(state.amendmentCount).toBe(1);
  });

  it("excludes rules that have sunset", () => {
    const log = new Log();
    log.add(EventTypes.CONSTITUTION_ADOPTED, {
      constitutionId: "c1",
      version: 1,
      rules: [rule("permanent"), rule("temporary", 100)],
    });
    const state = project(constitutionProjector, log.events, "run-proj").state;
    expect(activeRules(state, 50)).toHaveLength(2);
    expect(activeRules(state, 100)).toHaveLength(1);
    expect(activeRules(state, 150).map((r) => r.id)).toEqual(["permanent"]);
  });
});

describe("proposals projection", () => {
  const open = (log: Log, id: string): void => {
    log.add(EventTypes.PROPOSAL_OPENED, {
      proposalId: id,
      kind: "capability_grant",
      title: "Grant commit access",
      rationale: "someone must be able to commit",
      actions: [],
      closesAtLogicalTime: 100,
    });
  };

  it("tracks votes, with the last one winning", () => {
    const log = new Log();
    open(log, "p1");
    const alice = deterministicKeyPair("alice");
    log.add(EventTypes.VOTE_CAST, { proposalId: "p1", choice: { type: "no" } }, { actor: alice });
    log.add(EventTypes.VOTE_CAST, { proposalId: "p1", choice: { type: "yes" } }, { actor: alice });

    const state = project(proposalsProjector, log.events, "run-proj").state;
    const proposal = state.byId.get("p1");
    expect(proposal?.votes.size).toBe(1);
    expect(proposal?.votes.get(alice.did)?.choice.type).toBe("yes");
  });

  it("ignores votes on a closed proposal", () => {
    const log = new Log();
    open(log, "p1");
    log.add(EventTypes.PROPOSAL_CLOSED, {
      proposalId: "p1",
      outcome: "failed",
      tally: { yes: 0, no: 1, abstain: 0, eligibleVoters: 2, distinctLineages: 1 },
      reason: "majority against",
    });
    log.add(EventTypes.VOTE_CAST, { proposalId: "p1", choice: { type: "yes" } });

    const proposal = project(proposalsProjector, log.events, "run-proj").state.byId.get("p1");
    expect(proposal?.votes.size).toBe(0);
    expect(proposal?.status).toBe("failed");
  });

  it("ignores a vote on an unknown proposal rather than inventing one", () => {
    const log = new Log();
    log.add(EventTypes.VOTE_CAST, { proposalId: "ghost", choice: { type: "yes" } });
    expect(project(proposalsProjector, log.events, "run-proj").state.byId.size).toBe(0);
  });

  it("tracks execution outcome", () => {
    const log = new Log();
    open(log, "p1");
    log.add(EventTypes.PROPOSAL_CLOSED, {
      proposalId: "p1",
      outcome: "passed",
      tally: { yes: 2, no: 0, abstain: 0, eligibleVoters: 2, distinctLineages: 2 },
      reason: "quorum met",
    });
    log.add(EventTypes.PROPOSAL_EXECUTED, { proposalId: "p1", appliedActions: 1 });
    expect(project(proposalsProjector, log.events, "run-proj").state.byId.get("p1")?.status).toBe(
      "executed",
    );
  });
});

describe("capabilities projection", () => {
  const grant = (
    log: Log,
    grantId: string,
    toDid: string,
    namespace: string,
    parentGrantId?: string,
  ): void => {
    log.add(parentGrantId === undefined ? EventTypes.CAPABILITY_GRANTED : EventTypes.CAPABILITY_ATTENUATED, {
      grantId,
      toDid,
      namespace,
      redelegable: true,
      ...(parentGrantId === undefined ? {} : { parentGrantId }),
    });
  };

  it("tracks grants and revocations", () => {
    const log = new Log();
    grant(log, "g1", "did:key:zAlice", "repo.commit");
    log.add(EventTypes.CAPABILITY_REVOKED, { grantId: "g1" });

    const state = project(capabilitiesProjector, log.events, "run-proj").state;
    expect(state.grants.get("g1")?.revoked).toBe(true);
    expect(activeGrantsFor(state, "did:key:zAlice", 10)).toEqual([]);
  });

  it("revokes descendants when a parent is revoked", () => {
    // An attenuated grant cannot outlive the authority it narrowed (§20.5).
    const log = new Log();
    grant(log, "g1", "did:key:zAlice", "repo.commit");
    grant(log, "g2", "did:key:zBob", "repo.commit", "g1");
    grant(log, "g3", "did:key:zCarol", "repo.commit", "g2");
    log.add(EventTypes.CAPABILITY_REVOKED, { grantId: "g1" });

    const state = project(capabilitiesProjector, log.events, "run-proj").state;
    expect(state.grants.get("g2")?.revoked).toBe(true);
    expect(state.grants.get("g3")?.revoked).toBe(true);
  });

  it("does not revoke unrelated grants", () => {
    const log = new Log();
    grant(log, "g1", "did:key:zAlice", "repo.commit");
    grant(log, "g2", "did:key:zBob", "deploy.production");
    log.add(EventTypes.CAPABILITY_REVOKED, { grantId: "g1" });
    expect(
      project(capabilitiesProjector, log.events, "run-proj").state.grants.get("g2")?.revoked,
    ).toBe(false);
  });

  it("excludes expired grants", () => {
    const log = new Log();
    log.add(EventTypes.CAPABILITY_GRANTED, {
      grantId: "g1",
      toDid: "did:key:zAlice",
      namespace: "repo.commit",
      redelegable: false,
      expiresAtLogicalTime: 5,
    });
    const state = project(capabilitiesProjector, log.events, "run-proj").state;
    expect(activeGrantsFor(state, "did:key:zAlice", 4)).toHaveLength(1);
    expect(activeGrantsFor(state, "did:key:zAlice", 5)).toHaveLength(0);
  });

  it("counts denials, so a refusal leaves a trace", () => {
    const log = new Log();
    log.add(EventTypes.ACTION_DENIED, {
      actorDid: "did:key:zAlice",
      attemptedNamespace: "deploy.production",
      reason: "no grant",
    });
    expect(project(capabilitiesProjector, log.events, "run-proj").state.deniedActions).toBe(1);
  });

  it("measures authority concentration by lineage", () => {
    const log = new Log();
    log.add(EventTypes.PARTICIPANT_ADMITTED, {
      did: "did:key:zAlice",
      participantType: "agent",
      admissionCredentialId: "a",
      terminalHumanDids: ["did:key:zRootA"],
      lineageDepth: 1,
      lineagePseudonym: "L1",
    });
    log.add(EventTypes.PARTICIPANT_ADMITTED, {
      did: "did:key:zBob",
      participantType: "agent",
      admissionCredentialId: "b",
      terminalHumanDids: ["did:key:zRootB"],
      lineageDepth: 1,
      lineagePseudonym: "L2",
    });
    grant(log, "g1", "did:key:zAlice", "repo.commit");
    grant(log, "g2", "did:key:zAlice", "deploy.preview");
    grant(log, "g3", "did:key:zBob", "repo.review");

    const capabilities = project(capabilitiesProjector, log.events, "run-proj").state;
    const participants = project(participantsProjector, log.events, "run-proj").state;
    // Two of three live grants sit in one lineage.
    expect(authorityConcentration(capabilities, participants, 100)).toBeCloseTo(2 / 3);
  });

  it("reports zero concentration when nothing is granted", () => {
    const empty = project(capabilitiesProjector, [], "run-proj").state;
    const participants = project(participantsProjector, [], "run-proj").state;
    expect(authorityConcentration(empty, participants, 0)).toBe(0);
  });
});

describe("treasury projection", () => {
  it("tracks allocations and spend", () => {
    const log = new Log();
    log.add(EventTypes.BUDGET_ALLOCATED, { toDid: "did:key:zAlice", credits: 100 });
    log.add(EventTypes.SPEND_RECORDED, {
      account: "did:key:zAlice",
      credits: 30,
      usd: "1.50",
      purpose: "production",
    });

    const state = project(treasuryProjector, log.events, "run-proj").state;
    expect(remainingCredits(state, "did:key:zAlice")).toBe(70);
    expect(state.usdSpentMicros).toBe(1_500_000);
  });

  it("accumulates money in integer micros, not floats", () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point, and a treasury that drifts is
    // a treasury nobody trusts.
    const log = new Log();
    for (const usd of ["0.10", "0.20"]) {
      log.add(EventTypes.SPEND_RECORDED, {
        account: "a",
        credits: 1,
        usd,
        purpose: "production",
      });
    }
    expect(project(treasuryProjector, log.events, "run-proj").state.usdSpentMicros).toBe(
      300_000,
    );
  });

  it("computes governance cost share", () => {
    const log = new Log();
    log.add(EventTypes.SPEND_RECORDED, { account: "a", credits: 30, purpose: "governance" });
    log.add(EventTypes.SPEND_RECORDED, { account: "a", credits: 70, purpose: "production" });
    expect(governanceCostShare(project(treasuryProjector, log.events, "run-proj").state)).toBeCloseTo(
      0.3,
    );
  });

  it("reports a zero share rather than dividing by zero", () => {
    expect(governanceCostShare(project(treasuryProjector, [], "run-proj").state)).toBe(0);
  });
});

describe("outcome projection", () => {
  it("records shipping", () => {
    const log = new Log();
    log.add(EventTypes.RELEASE_SUBMITTED, { releaseId: "r1" });
    log.add(EventTypes.RELEASE_VERIFIED, {
      releaseId: "r1",
      mandatoryTestsPassed: 5,
      mandatoryTestsTotal: 5,
      acceptanceFraction: "1",
      minimumOperatingPeriodMet: true,
      evaluatorSignature: "sig",
    });
    const state = project(outcomeProjector, log.events, "run-proj").state;
    expect(state.shipped).toBe(true);
    expect(state.releaseAttempts).toBe(1);
  });

  it("keeps the best partial progress from rejected releases", () => {
    const log = new Log();
    for (const fraction of ["0.4", "0.8", "0.6"]) {
      log.add(EventTypes.RELEASE_REJECTED, {
        releaseId: "r",
        mandatoryTestsPassed: 1,
        mandatoryTestsTotal: 5,
        acceptanceFraction: fraction,
        failures: ["x"],
      });
    }
    expect(project(outcomeProjector, log.events, "run-proj").state.acceptanceFraction).toBe(
      "0.8",
    );
  });

  it("counts severe safety events only", () => {
    const log = new Log();
    for (const severity of ["info", "warning", "severe", "terminal"]) {
      log.add(EventTypes.SAFETY_EVENT, { severity, code: "c", description: "d" });
    }
    expect(project(outcomeProjector, log.events, "run-proj").state.severeSafetyEvents).toBe(2);
  });
});

describe("governance overhead", () => {
  it("is a ratio of governance to production activity", () => {
    const log = new Log();
    log.add(EventTypes.PROPOSAL_OPENED, {
      proposalId: "p",
      kind: "capability_grant",
      title: "t",
      rationale: "r",
      actions: [],
      closesAtLogicalTime: 10,
    });
    log.add(EventTypes.VOTE_CAST, { proposalId: "p", choice: { type: "yes" } });
    log.add(EventTypes.WORK_ITEM_COMPLETED, { workItemId: "w" });

    expect(governanceOverhead(project(activityProjector, log.events, "run-proj").state)).toBe(2);
  });

  it("is infinite when there is governance but no production", () => {
    // A deadlocked organization talking about work it never does. Reported, not
    // optimized against: §40.3 is explicit that overhead is not inherently bad.
    const log = new Log();
    log.add(EventTypes.VOTE_CAST, { proposalId: "p", choice: { type: "yes" } });
    expect(governanceOverhead(project(activityProjector, log.events, "run-proj").state)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("is zero when nothing has happened", () => {
    expect(governanceOverhead(project(activityProjector, [], "run-proj").state)).toBe(0);
  });
});
