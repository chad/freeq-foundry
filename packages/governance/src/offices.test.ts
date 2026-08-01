import { describe, expect, it } from "vitest";
import {
  expiredOffices,
  officesHeldBy,
  officesOfSuspended,
  removeFromOffice,
  takeOffice,
  vacantOffices,
  type OfficeDefinition,
  type OfficeRegistry,
} from "./offices.js";
import type { ParticipantsState } from "@freeq-foundry/projections";

const ALICE = "did:key:zAlice";
const BOB = "did:key:zBob";

const office = (
  officeId: string,
  overrides: Partial<OfficeDefinition> = {},
): OfficeDefinition => ({
  officeId,
  title: officeId,
  capabilityNamespaces: ["deploy.production", "deploy.rollback"],
  termLogicalTime: 50,
  electionMethod: "approval",
  tieBreaks: ["lowest_did"],
  ...overrides,
});

const registry = (
  entries: readonly {
    readonly definition: OfficeDefinition;
    readonly holderDid?: string;
    readonly expiresAtLogicalTime?: number;
  }[],
): OfficeRegistry => ({
  byId: new Map(
    entries.map((entry) => [
      entry.definition.officeId,
      {
        definition: entry.definition,
        ...(entry.holderDid === undefined
          ? {}
          : {
              current: {
                holderDid: entry.holderDid,
                startedAtLogicalTime: 0,
                expiresAtLogicalTime: entry.expiresAtLogicalTime ?? 50,
                grantIds: [`${entry.definition.officeId}-g0`, `${entry.definition.officeId}-g1`],
              },
            }),
        history: [],
      },
    ]),
  ),
});

const participants = (suspended: readonly string[] = []): ParticipantsState => ({
  byDid: new Map(
    [ALICE, BOB].map((did) => [
      did,
      {
        did,
        participantType: "agent",
        admissionCredentialId: "adm",
        terminalHumanDids: [`root-${did}`],
        lineageDepth: 1,
        lineagePseudonym: `L-${did.slice(-3)}`,
        declaredAutonomy: "autonomous" as const,
        suspended: suspended.includes(did),
        admittedAtLogicalTime: 0,
        actionCount: 0,
        instructedActionCount: 0,
      },
    ]),
  ),
});

describe("taking office", () => {
  it("grants the office's namespaces to the holder, expiring with the term", () => {
    // The §18 rule: an office does not hold capabilities, its holder does — and a grant
    // that outlived its office would leave authority behind after the term ended.
    const outcome = takeOffice(registry([{ definition: office("rm") }]), participants(), {
      officeId: "rm",
      holderDid: ALICE,
      atLogicalTime: 10,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.value.kind === "assign_office") {
      expect(outcome.value.expiresAtLogicalTime).toBe(60);
      expect(outcome.value.grants).toHaveLength(2);
      for (const grant of outcome.value.grants) {
        expect(grant.expiresAtLogicalTime).toBe(60);
      }
    }
  });

  it("refuses an occupied office rather than replacing the holder", () => {
    // A silent replacement would displace a sitting holder without the §18.6 removal
    // procedure, which is what a coup looks like from the inside.
    const outcome = takeOffice(
      registry([{ definition: office("rm"), holderDid: BOB }]),
      participants(),
      { officeId: "rm", holderDid: ALICE, atLogicalTime: 10 },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("office_occupied");
  });

  it("refuses a suspended participant", () => {
    const outcome = takeOffice(
      registry([{ definition: office("rm") }]),
      participants([ALICE]),
      { officeId: "rm", holderDid: ALICE, atLogicalTime: 10 },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("suspended");
  });

  it("refuses a non-participant", () => {
    const outcome = takeOffice(registry([{ definition: office("rm") }]), participants(), {
      officeId: "rm",
      holderDid: "did:key:zGhost",
      atLogicalTime: 10,
    });
    expect(outcome.ok).toBe(false);
  });

  it("enforces separation of duties", () => {
    // §18.8: a single agent must not hold both the authority to ship and the authority
    // to approve shipping.
    const twoOffices = registry([
      { definition: office("reviewer"), holderDid: ALICE },
      { definition: office("rm", { exclusive: true }) },
    ]);
    const outcome = takeOffice(twoOffices, participants(), {
      officeId: "rm",
      holderDid: ALICE,
      atLogicalTime: 10,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("separation_of_duties");
  });

  it("allows a non-exclusive office alongside another", () => {
    const outcome = takeOffice(
      registry([
        { definition: office("reviewer"), holderDid: ALICE },
        { definition: office("rm", { exclusive: false }) },
      ]),
      participants(),
      { officeId: "rm", holderDid: ALICE, atLogicalTime: 10 },
    );
    expect(outcome.ok).toBe(true);
  });
});

describe("terms", () => {
  it("vacates an office whose term expired, revoking its grants", () => {
    // A term that quietly ran over would leave authority in place indefinitely.
    const effects = expiredOffices(
      registry([{ definition: office("rm"), holderDid: ALICE, expiresAtLogicalTime: 40 }]),
      40,
    );
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ kind: "vacate_office", reason: "term_expired" });
    if (effects[0]?.kind === "vacate_office") {
      expect(effects[0].revokeGrantIds).toHaveLength(2);
    }
  });

  it("leaves a live term alone", () => {
    expect(
      expiredOffices(
        registry([{ definition: office("rm"), holderDid: ALICE, expiresAtLogicalTime: 100 }]),
        40,
      ),
    ).toEqual([]);
  });

  it("vacates an office whose holder was suspended", () => {
    // §11.10 revokes a lineage; without this, revoking a root would strip a
    // participant's ability to act while leaving its office grants live.
    const effects = officesOfSuspended(
      registry([{ definition: office("rm"), holderDid: ALICE }]),
      participants([ALICE]),
    );
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ reason: "suspended" });
  });

  it("reports vacancies without being able to fill them", () => {
    // §18.7: a vacancy is filled by election, not appointment. Nothing here can
    // install a holder, deliberately.
    const vacant = vacantOffices(
      registry([{ definition: office("rm") }, { definition: office("held"), holderDid: BOB }]),
    );
    expect(vacant.map((o) => o.officeId)).toEqual(["rm"]);
  });

  it("reports what a participant holds", () => {
    expect(
      officesHeldBy(registry([{ definition: office("rm"), holderDid: ALICE }]), ALICE).map(
        (o) => o.officeId,
      ),
    ).toEqual(["rm"]);
  });
});

describe("removal", () => {
  it("removes a holder when the threshold is exceeded", () => {
    const outcome = removeFromOffice(
      registry([{ definition: office("rm", { removalThresholdPct: 50 }), holderDid: ALICE }]),
      { officeId: "rm", votesFor: 3, eligibleVoters: 4, atLogicalTime: 20 },
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.value.kind === "vacate_office") {
      expect(outcome.value.reason).toBe("removed");
      expect(outcome.value.revokeGrantIds).toHaveLength(2);
    }
  });

  it("refuses removal at exactly the threshold", () => {
    // "More than" the threshold, not "at least": an office removable on a tie is not
    // much of an office.
    const outcome = removeFromOffice(
      registry([{ definition: office("rm", { removalThresholdPct: 50 }), holderDid: ALICE }]),
      { officeId: "rm", votesFor: 2, eligibleVoters: 4, atLogicalTime: 20 },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("threshold_not_met");
  });

  it("honours a higher threshold than an ordinary proposal", () => {
    const outcome = removeFromOffice(
      registry([{ definition: office("rm", { removalThresholdPct: 66 }), holderDid: ALICE }]),
      { officeId: "rm", votesFor: 3, eligibleVoters: 5, atLogicalTime: 20 },
    );
    expect(outcome.ok).toBe(false);
  });

  it("refuses to remove from a vacant office", () => {
    const outcome = removeFromOffice(registry([{ definition: office("rm") }]), {
      officeId: "rm",
      votesFor: 10,
      eligibleVoters: 10,
      atLogicalTime: 20,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("office_vacant");
  });
});
