/**
 * End-to-end runs.
 *
 * This is the test that says whether the thing works: a population is admitted,
 * proposes a capability grant, votes, executes the grant, does work under that
 * authority, and ships to an evaluator that governance cannot influence — all of
 * it a signed, replayable event log.
 *
 * No model is involved. Every agent is deterministic, so a failure here is a
 * harness bug rather than model variance.
 */
import {
  RunTerminationReason,
  RunValidity,
  deterministicKeyPair,
  verifyChain,
} from "@freeq-foundry/protocol";
import {
  EventTypes,
  authorityConcentration,
  distinctLineages,
  governanceOverhead,
  remainingCredits,
} from "@freeq-foundry/projections";
import {
  builderAgent,
  institutionalistAgent,
  weakSaboteurAgent,
} from "@freeq-foundry/agents";
import { describe, expect, it } from "vitest";
import { executeRun, type ParticipantSpec, type RunConfig, type Scenario } from "./run.js";

const recorder = deterministicKeyPair("recorder");
const controller = deterministicKeyPair("controller");
const evaluator = deterministicKeyPair("evaluator");

const scenario: Scenario = {
  scenarioId: "webhook-saas-v1",
  workItems: [
    { workItemId: "api-endpoint", mandatory: true },
    { workItemId: "persistence", mandatory: true },
  ],
  genesisCreditsPerParticipant: 200,
  maxTicks: 60,
  msPerTick: 60_000,
};

function cooperativePopulation(): readonly ParticipantSpec[] {
  const alice = deterministicKeyPair("alice");
  const bob = deterministicKeyPair("bob");
  const carol = deterministicKeyPair("carol");

  return [
    {
      keyPair: alice,
      adapter: builderAgent("alice-builder", alice.did),
      humanRoot: deterministicKeyPair("human-one"),
      declaredAutonomy: "autonomous",
    },
    {
      keyPair: bob,
      adapter: institutionalistAgent("bob-institutionalist"),
      humanRoot: deterministicKeyPair("human-two"),
      declaredAutonomy: "autonomous",
    },
    {
      keyPair: carol,
      adapter: builderAgent("carol-builder", alice.did),
      humanRoot: deterministicKeyPair("human-three"),
      declaredAutonomy: "autonomous",
    },
  ];
}

const baseConfig = (overrides: Partial<RunConfig> = {}): RunConfig => ({
  runId: "run-e2e-001",
  scenario,
  participants: cooperativePopulation(),
  recorder,
  controller,
  evaluator,
  ...overrides,
});

describe("end-to-end: a cooperative run ships", () => {
  it("reaches a verified release", async () => {
    const result = await executeRun(baseConfig());

    expect(result.terminationReason).toBe(RunTerminationReason.SHIPPED);
    expect(result.shipped).toBe(true);
    expect(result.timeToReleaseMs).toBeGreaterThan(0);
    expect(result.validity).toBe(RunValidity.VALID);
  });

  it("produces a valid signed chain", async () => {
    // The whole point: the institutional history is the artifact, and it must
    // verify.
    const result = await executeRun(baseConfig());
    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);

    const verification = verifyChain(events, {
      runId: result.runId,
      recorderDid: recorder.did,
    });
    expect(verification.violations).toEqual([]);
    expect(verification.checked).toBe(result.eventCount);
  });

  it("adopts a constitution and grants authority through it", async () => {
    const result = await executeRun(baseConfig());

    expect(result.state.constitution.version).toBeGreaterThanOrEqual(1);
    const proposals = [...result.state.proposals.byId.values()];
    expect(proposals.some((p) => p.status === "executed")).toBe(true);

    const grants = [...result.state.capabilities.grants.values()];
    expect(grants.length).toBeGreaterThan(0);
    // Every grant traces to a proposal. No authority appeared from nowhere.
    for (const grant of grants) {
      expect(grant.grantedByProposalId).toBeDefined();
    }
  });

  it("does work only under granted authority", async () => {
    const result = await executeRun(baseConfig());
    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);

    const firstGrant = events.findIndex((e) => e.eventType === EventTypes.CAPABILITY_GRANTED);
    const firstClaim = events.findIndex((e) => e.eventType === EventTypes.WORK_ITEM_CLAIMED);

    expect(firstGrant).toBeGreaterThanOrEqual(0);
    expect(firstClaim).toBeGreaterThan(firstGrant);
  });

  it("has the evaluator, not governance, declare success", async () => {
    // §59.10: the organization cannot vote itself successful.
    const result = await executeRun(baseConfig());
    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);

    const verified = events.filter((e) => e.eventType === EventTypes.RELEASE_VERIFIED);
    expect(verified).toHaveLength(1);
    expect(verified[0]?.actorDid).toBe(evaluator.did);
  });

  it("is deterministic: the same configuration produces the same history", async () => {
    // The property that makes replay and matched-block comparison possible.
    const first = await executeRun(baseConfig());
    const second = await executeRun(baseConfig());

    expect(second.eventCount).toBe(first.eventCount);
    expect(second.timeToReleaseMs).toBe(first.timeToReleaseMs);
    expect(second.terminationReason).toBe(first.terminationReason);

    const hashesOf = async (r: typeof first): Promise<string[]> => {
      const out: string[] = [];
      for await (const event of r.store.read(r.runId)) out.push(event.eventHash);
      return out;
    };
    expect(await hashesOf(second)).toEqual(await hashesOf(first));
  });

  it("charges credits for every activation, so scarcity binds", async () => {
    const result = await executeRun(baseConfig());
    for (const participant of cooperativePopulation()) {
      const remaining = remainingCredits(result.state.treasury, participant.keyPair.did);
      expect(remaining).toBeLessThan(scenario.genesisCreditsPerParticipant);
    }
  });

  it("records lineage diversity", async () => {
    const result = await executeRun(baseConfig());
    expect(distinctLineages(result.state.participants)).toBe(3);
  });

  it("reports authority concentration", async () => {
    const result = await executeRun(baseConfig());
    const concentration = authorityConcentration(
      result.state.capabilities,
      result.state.participants,
      result.state.run.lastLogicalTime,
    );
    expect(concentration).toBeGreaterThan(0);
    expect(concentration).toBeLessThanOrEqual(1);
  });

  it("reports governance overhead as a finite ratio", async () => {
    const result = await executeRun(baseConfig());
    const overhead = governanceOverhead(result.state.activity);
    expect(Number.isFinite(overhead)).toBe(true);
  });

  it("puts the manifest hash inside the record", async () => {
    // ADR-0009: a run's membership in a confirmatory set must be checkable.
    const result = await executeRun(baseConfig({ confirmatory: true, arm: "capability_enforced" }));
    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);
    const started = events.find((e) => e.eventType === EventTypes.RUN_STARTED);
    const payload = started?.payload as { manifestHash: string; confirmatory: boolean };
    expect(payload.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(payload.confirmatory).toBe(true);
  });
});

describe("end-to-end: capability enforcement is load-bearing", () => {
  const withSaboteur = (): readonly ParticipantSpec[] => {
    const mallory = deterministicKeyPair("mallory");
    return [
      ...cooperativePopulation(),
      {
        keyPair: mallory,
        adapter: weakSaboteurAgent("mallory-saboteur"),
        humanRoot: deterministicKeyPair("human-four"),
        declaredAutonomy: "autonomous",
      },
    ];
  };

  it("denies unauthorized actions and records the denial", async () => {
    // §20.7: a refusal that leaves no trace is a hole in the research record.
    const result = await executeRun(
      baseConfig({ runId: "run-sabotage", participants: withSaboteur() }),
    );
    expect(result.state.capabilities.deniedActions).toBeGreaterThan(0);
  });

  it("still ships despite a saboteur voting against everything", async () => {
    // Institutional stress is part of the experiment (§23), and an organization
    // that has never been tested has not been shown to work.
    const result = await executeRun(
      baseConfig({ runId: "run-sabotage-2", participants: withSaboteur() }),
    );
    expect(result.shipped).toBe(true);
  });

  it("records denials in the unenforced arm too, so the arms are comparable", async () => {
    // §49.6 Condition F. The two arms must differ only in enforcement, not in
    // what is observable, or the comparison measures the wrong thing.
    const enforced = await executeRun(
      baseConfig({
        runId: "run-enforced",
        participants: withSaboteur(),
        enforceCapabilities: true,
        arm: "capability_enforced",
      }),
    );
    const unenforced = await executeRun(
      baseConfig({
        runId: "run-unenforced",
        participants: withSaboteur(),
        enforceCapabilities: false,
        arm: "unenforced_governance",
      }),
    );

    expect(enforced.state.capabilities.deniedActions).toBeGreaterThan(0);
    expect(unenforced.state.capabilities.deniedActions).toBeGreaterThan(0);
  });

  it("lets work proceed without a grant when enforcement is off", async () => {
    // The mechanism the contrast tests. With enforcement off, an agent that was
    // refused commit access can claim work anyway.
    const single = [cooperativePopulation()[0] as ParticipantSpec];
    const unenforced = await executeRun(
      baseConfig({
        runId: "run-unenforced-solo",
        participants: single,
        enforceCapabilities: false,
      }),
    );
    const events = [];
    for await (const event of unenforced.store.read(unenforced.runId)) events.push(event);

    const denied = events.filter((e) => e.eventType === EventTypes.ACTION_DENIED);
    const claimed = events.filter((e) => e.eventType === EventTypes.WORK_ITEM_CLAIMED);
    expect(denied.length).toBeGreaterThan(0);
    expect(claimed.length).toBeGreaterThan(0);
  });

  it("blocks a solo agent under enforcement, since one lineage cannot pass a proposal", async () => {
    // The genesis quorum requires two distinct lineages, so a single participant
    // cannot grant itself authority. That is the invariant working.
    const single = [cooperativePopulation()[0] as ParticipantSpec];
    const enforced = await executeRun(
      baseConfig({
        runId: "run-enforced-solo",
        participants: single,
        enforceCapabilities: true,
      }),
    );
    expect(enforced.shipped).toBe(false);
    expect(enforced.state.capabilities.grants.size).toBe(0);
  });
});

describe("end-to-end: termination", () => {
  it("terminates at the horizon when nothing ships", async () => {
    const result = await executeRun(
      baseConfig({
        runId: "run-horizon",
        participants: [],
        scenario: { ...scenario, maxTicks: 1000, msPerTick: 60 * 60 * 1000 },
      }),
    );
    expect(result.terminationReason).toBe(RunTerminationReason.HORIZON_REACHED);
    expect(result.shipped).toBe(false);
  });

  it("terminates when the budget is exhausted", async () => {
    const result = await executeRun(
      baseConfig({
        runId: "run-broke",
        scenario: { ...scenario, genesisCreditsPerParticipant: 2, maxTicks: 200 },
      }),
    );
    expect(result.terminationReason).toBe(RunTerminationReason.BUDGET_EXHAUSTED);
  });

  it("always terminates, and always records why", async () => {
    // A run that cannot end cannot be analyzed.
    for (const maxTicks of [1, 5, 20]) {
      const result = await executeRun(
        baseConfig({ runId: `run-ticks-${maxTicks}`, scenario: { ...scenario, maxTicks } }),
      );
      expect(result.state.run.terminated).toBe(true);
      expect(result.terminationReason).toBeDefined();
      expect(result.ticks).toBeLessThanOrEqual(maxTicks);
    }
  });

  it("computes the primary outcome on the run clock", async () => {
    const result = await executeRun(baseConfig({ runId: "run-clock" }));
    expect(result.timeToReleaseMs).toBeDefined();
    // Ticks advance the simulated clock, so elapsed time is a multiple of the
    // tick size rather than real time.
    expect((result.timeToReleaseMs as number) % (scenario.msPerTick as number)).toBe(0);
  });
});

describe("end-to-end: the log is the artifact", () => {
  it("rebuilds every projection from the log alone", async () => {
    // §6.9: all authoritative state must be reconstructable from the event log.
    const result = await executeRun(baseConfig({ runId: "run-replay" }));
    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);

    const { coreProjectors, projectAll } = await import("@freeq-foundry/projections");
    const rebuilt = projectAll(coreProjectors as never, events, result.runId);

    expect(rebuilt.get("outcome")?.state).toEqual(result.state.outcome);
    expect(rebuilt.get("capabilities")?.state).toEqual(result.state.capabilities);
    expect(rebuilt.get("constitution")?.state).toEqual(result.state.constitution);
    expect(rebuilt.get("treasury")?.state).toEqual(result.state.treasury);
  });

  it("detects tampering with the produced history", async () => {
    const result = await executeRun(baseConfig({ runId: "run-tamper" }));
    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);

    const tampered = JSON.parse(JSON.stringify(events)) as typeof events;
    const target = tampered[4] as { payload: unknown };
    target.payload = { tampered: true };

    const verification = verifyChain(tampered, {
      runId: result.runId,
      recorderDid: recorder.did,
    });
    expect(verification.valid).toBe(false);
    expect(verification.firstBadIndex).toBe(4);
  });

  it("attributes every event to a signer and a human root", async () => {
    // §6.4, the attribution invariant, on real produced history rather than a
    // synthetic fixture.
    const result = await executeRun(baseConfig({ runId: "run-attrib" }));
    for await (const event of result.store.read(result.runId)) {
      expect(event.provenance.signerDid).toBe(event.actorDid);
      expect(event.provenance.terminalHumanDids.length).toBeGreaterThan(0);
      expect(event.provenance.admissionCredentialId).not.toBe("");
    }
  });
});

describe("end-to-end: provenance is verified, not asserted", () => {
  it("derives lineage pseudonyms from the verified chain", async () => {
    // A scenario can no longer claim a lineage it cannot prove: the pseudonym is
    // computed from the credential chain at admission.
    const result = await executeRun(baseConfig({ runId: "run-lineage" }));
    for (const participant of result.state.participants.byDid.values()) {
      expect(participant.lineagePseudonym).toMatch(/^L-[0-9a-f]{12}$/);
      expect(participant.terminalHumanDids[0]).toMatch(/^did:key:z/);
    }
  });

  it("records the credential chain for every participant", async () => {
    const result = await executeRun(baseConfig({ runId: "run-creds" }));
    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);

    const issued = events.filter((e) => e.eventType === EventTypes.CREDENTIAL_ISSUED);
    expect(issued).toHaveLength(3);
    for (const event of issued) {
      const payload = event.payload as { credentialIds: string[]; chainHash: string };
      expect(payload.credentialIds.length).toBeGreaterThanOrEqual(2);
      expect(payload.chainHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("refuses an applicant whose lineage is too deep, and records the refusal", async () => {
    // §11.4 condition 9. Silently dropping the applicant would leave the
    // population unexplained (§12.5).
    const deep = cooperativePopulation().map((p) => ({ ...p, lineageDepth: 5 }));
    const result = await executeRun(
      baseConfig({
        runId: "run-too-deep",
        participants: deep,
        lineageConstraints: { maxDepth: 2, maxFanOutPerRoot: 8 },
      }),
    );

    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);
    const rejected = events.filter((e) => e.eventType === EventTypes.PARTICIPANT_REJECTED);

    expect(rejected).toHaveLength(3);
    expect((rejected[0]?.payload as { reason: string }).reason).toBe("depth_exceeded");
    expect(result.state.participants.byDid.size).toBe(0);
    expect(result.shipped).toBe(false);
  });

  it("admits a deeper lineage when the ceiling allows it", async () => {
    const deep = cooperativePopulation().map((p) => ({ ...p, lineageDepth: 3 }));
    const result = await executeRun(
      baseConfig({
        runId: "run-deep-ok",
        participants: deep,
        lineageConstraints: { maxDepth: 4, maxFanOutPerRoot: 8 },
      }),
    );
    expect(result.state.participants.byDid.size).toBe(3);
    for (const participant of result.state.participants.byDid.values()) {
      expect(participant.lineageDepth).toBe(3);
    }
  });

  it("enforces the fan-out ceiling per human root", async () => {
    // §58.4: a generous platform limit that governance cannot raise. Three agents
    // sharing one root, ceiling of two.
    const sharedRoot = deterministicKeyPair("human-shared");
    const shared = cooperativePopulation().map((p) => ({ ...p, humanRoot: sharedRoot }));
    const result = await executeRun(
      baseConfig({
        runId: "run-fanout",
        participants: shared,
        lineageConstraints: { maxDepth: 4, maxFanOutPerRoot: 2 },
      }),
    );

    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);
    const rejected = events.filter((e) => e.eventType === EventTypes.PARTICIPANT_REJECTED);

    expect(result.state.participants.byDid.size).toBe(2);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]?.payload as { reason: string }).reason).toBe("fan_out_exceeded");
  });

  it("cannot ship when every agent shares one lineage", async () => {
    // The genesis quorum needs two distinct human roots. Verified provenance means
    // three agents from one operator are now genuinely one lineage, not three.
    const sharedRoot = deterministicKeyPair("human-solo");
    const shared = cooperativePopulation().map((p) => ({ ...p, humanRoot: sharedRoot }));
    const result = await executeRun(
      baseConfig({ runId: "run-one-lineage", participants: shared }),
    );

    expect(result.state.participants.byDid.size).toBe(3);
    expect(distinctLineages(result.state.participants)).toBe(1);
    expect(result.state.capabilities.grants.size).toBe(0);
    expect(result.shipped).toBe(false);
  });

  it("suspends descendants when a root credential is revoked mid-run", async () => {
    // §11.10, exercised inside a real run rather than only in unit tests.
    const rootId = `hrc-${deterministicKeyPair("human-one").did.slice(-8)}`;
    const result = await executeRun(
      baseConfig({
        runId: "run-revoke",
        revokeAtTick: new Map([[2, rootId]]),
        scenario: { ...scenario, maxTicks: 30 },
      }),
    );

    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);

    const revoked = events.filter((e) => e.eventType === EventTypes.CREDENTIAL_REVOKED);
    const suspended = events.filter((e) => e.eventType === EventTypes.PARTICIPANT_SUSPENDED);

    expect(revoked).toHaveLength(1);
    expect(suspended.length).toBeGreaterThan(0);
    // The suspension cites the credential that caused it, so the cascade is
    // explicable rather than mysterious.
    expect((suspended[0]?.payload as { causedByCredentialId: string }).causedByCredentialId).toBe(
      rootId,
    );
    for (const event of suspended) {
      const did = (event.payload as { did: string }).did;
      expect(result.state.participants.byDid.get(did)?.suspended).toBe(true);
    }
  });

  it("keeps history intact after a revocation", async () => {
    // §6.8: revocation does not erase past events, and the chain must still verify.
    const rootId = `hrc-${deterministicKeyPair("human-one").did.slice(-8)}`;
    const result = await executeRun(
      baseConfig({
        runId: "run-revoke-history",
        revokeAtTick: new Map([[2, rootId]]),
        scenario: { ...scenario, maxTicks: 30 },
      }),
    );
    const events = [];
    for await (const event of result.store.read(result.runId)) events.push(event);

    expect(
      verifyChain(events, { runId: result.runId, recorderDid: recorder.did }).violations,
    ).toEqual([]);
    // The suspended participant's earlier actions are still in the log.
    expect(events.some((e) => e.eventType === EventTypes.PARTICIPANT_ADMITTED)).toBe(true);
  });

  it("stays deterministic with credential verification in the path", async () => {
    const first = await executeRun(baseConfig({ runId: "run-det-creds" }));
    const second = await executeRun(baseConfig({ runId: "run-det-creds" }));
    const hashesOf = async (r: typeof first): Promise<string[]> => {
      const out: string[] = [];
      for await (const event of r.store.read(r.runId)) out.push(event.eventHash);
      return out;
    };
    expect(await hashesOf(second)).toEqual(await hashesOf(first));
  });
});
