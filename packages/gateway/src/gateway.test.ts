import { InMemoryEventStore } from "@freeq-foundry/event-store";
import {
  ProtocolErrorCode,
  attestEvent,
  deterministicKeyPair,
  type AttributedEvent,
  type DraftEvent,
  type KeyPair,
  type ParticipantType,
  type VisibilityPolicy,
} from "@freeq-foundry/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Gateway,
  StaticAdmissionRegistry,
  canSee,
  type Viewer,
} from "./gateway.js";

const RUN = "run-gateway";
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const recorder = deterministicKeyPair("recorder");

interface Actor {
  readonly did: string;
  readonly keyPair: KeyPair;
  readonly participantType: ParticipantType;
  sequence: number;
}

function actor(label: string, participantType: ParticipantType = "agent"): Actor {
  const keyPair = deterministicKeyPair(label);
  return { did: keyPair.did, keyPair, participantType, sequence: 0 };
}

function draft(
  who: Actor,
  overrides: Partial<DraftEvent> = {},
  sequence?: number,
): DraftEvent {
  const seq = sequence ?? ++who.sequence;
  return {
    eventId: `${RUN}-${who.did.slice(-6)}-${seq}`,
    runId: RUN,
    eventType: "channel.message",
    schemaVersion: 1,
    actorDid: who.did,
    participantType: who.participantType,
    participantSequence: seq,
    wallTime: new Date(NOW).toISOString(),
    payload: { text: "hello" },
    visibility: { type: "public" },
    references: [],
    provenance: {
      signerDid: who.did,
      terminalHumanDids: [who.did],
      provenancePathHashes: [],
      admissionCredentialId: `adm-${who.did.slice(-6)}`,
      directInstructionEventIds: [],
      governanceAuthorizationIds: [],
      capabilityGrantIds: [],
    },
    ...overrides,
  };
}

function attest(who: Actor, overrides: Partial<DraftEvent> = {}, sequence?: number) {
  return attestEvent(draft(who, overrides, sequence), who.keyPair.privateKey);
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

describe("Gateway", () => {
  let store: InMemoryEventStore;
  let admissions: StaticAdmissionRegistry;
  let gateway: Gateway;
  let alice: Actor;
  let bob: Actor;

  beforeEach(async () => {
    store = new InMemoryEventStore({
      recorderDid: recorder.did,
      recorderPrivateKey: recorder.privateKey,
    });
    await store.registerRun({ runId: RUN, recorderDid: recorder.did });

    admissions = new StaticAdmissionRegistry();
    alice = actor("alice");
    bob = actor("bob");
    for (const who of [alice, bob]) {
      admissions.admit(RUN, {
        did: who.did,
        participantType: who.participantType,
        admissionCredentialId: `adm-${who.did.slice(-6)}`,
      });
    }

    gateway = new Gateway({ store, admissions, now: () => NOW });
  });

  describe("submission", () => {
    it("accepts an admitted participant and returns the assigned position", async () => {
      const result = await gateway.submit(attest(alice));
      expect(result.accepted).toBe(true);
      if (result.accepted) {
        expect(result.logicalTime).toBe(0);
        expect(result.eventHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(result.duplicate).toBe(false);
      }
    });

    it("assigns increasing positions across participants", async () => {
      const first = await gateway.submit(attest(alice));
      const second = await gateway.submit(attest(bob));
      expect(first.accepted && first.logicalTime).toBe(0);
      expect(second.accepted && second.logicalTime).toBe(1);
    });

    it("acknowledges a retry idempotently rather than failing it", async () => {
      // A lost acknowledgement is a normal occurrence, not an error (§36.9).
      const event = attest(alice);
      const first = await gateway.submit(event);
      const retry = await gateway.submit(event);

      expect(retry.accepted).toBe(true);
      if (first.accepted && retry.accepted) {
        expect(retry.logicalTime).toBe(first.logicalTime);
        expect(retry.eventHash).toBe(first.eventHash);
        // Flagged, because a client stuck in a retry loop is worth noticing.
        expect(retry.duplicate).toBe(true);
      }
    });

    it("exposes the current sequence so a client can resynchronize", async () => {
      await gateway.submit(attest(alice));
      await gateway.submit(attest(alice));
      expect(await gateway.sequenceFor(RUN, alice.did)).toBe(2);
      expect(await gateway.sequenceFor(RUN, bob.did)).toBe(0);
    });
  });

  describe("admission", () => {
    it("rejects an unadmitted participant", async () => {
      const stranger = actor("stranger");
      const result = await gateway.submit(attest(stranger));
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.code).toBe(ProtocolErrorCode.UNKNOWN_RUN);
        expect(result.remediation).toContain("admission");
      }
    });

    it("rejects a suspended participant, and says so", async () => {
      // Being told "suspended" is actionable; being told "signature invalid"
      // would send an operator debugging the wrong thing.
      admissions.suspend(RUN, alice.did);
      const result = await gateway.submit(attest(alice));
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.message).toContain("suspended");
        expect(result.remediation).toContain("reinstated");
      }
    });

    it("rejects a participant type that does not match admission", async () => {
      const result = await gateway.submit(
        attest(alice, { participantType: "controller" }),
      );
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.path).toBe("/participantType");
    });

    it("rejects a mismatched admission credential", async () => {
      const result = await gateway.submit(
        attest(alice, {
          provenance: {
            ...draft(alice).provenance,
            admissionCredentialId: "adm-forged",
          },
        }),
      );
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.path).toBe("/provenance/admissionCredentialId");
      }
    });

    it("checks admission before cryptography", async () => {
      // Ordering matters for diagnosability: a stranger with a bad signature
      // should hear that they are not admitted.
      const stranger = actor("stranger");
      const tampered = {
        ...attest(stranger),
        payload: { text: "tampered" },
      } as AttributedEvent;
      const result = await gateway.submit(tampered);
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.code).toBe(ProtocolErrorCode.UNKNOWN_RUN);
    });
  });

  describe("rejections carry remediation", () => {
    it("for a stale sequence", async () => {
      await gateway.submit(attest(alice, {}, 1));
      const result = await gateway.submit(
        attest(alice, { eventId: "distinct-1" }, 1),
      );
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.code).toBe(ProtocolErrorCode.STALE_SEQUENCE);
        expect(result.remediation).toContain("already accepted");
      }
    });

    it("for a gapped sequence, distinctly", async () => {
      const result = await gateway.submit(attest(alice, {}, 5));
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.code).toBe(ProtocolErrorCode.GAPPED_SEQUENCE);
        expect(result.remediation).toContain("may have been lost");
      }
    });

    it("for a tampered payload", async () => {
      const tampered = {
        ...attest(alice),
        payload: { text: "altered after signing" },
      } as AttributedEvent;
      const result = await gateway.submit(tampered);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.code).toBe(ProtocolErrorCode.INVALID_SIGNATURE);
        expect(result.remediation).toContain("signing key");
      }
    });

    it("for a missing signature", async () => {
      const unsigned = { ...draft(alice), signature: "" } as AttributedEvent;
      const result = await gateway.submit(unsigned);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.code).toBe(ProtocolErrorCode.MISSING_SIGNATURE);
      }
    });

    it("for a closed run", async () => {
      await store.closeRun(RUN);
      const result = await gateway.submit(attest(alice));
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.code).toBe(ProtocolErrorCode.RUN_CLOSED);
    });
  });

  describe("submissions may not carry position", () => {
    for (const field of [
      "logicalTime",
      "previousEventHash",
      "eventHash",
      "recorderSignature",
    ]) {
      it(`rejects a submission carrying ${field}`, async () => {
        // A client that could set position could place itself in history.
        const submission = {
          ...attest(alice),
          [field]: field === "logicalTime" ? 0 : `sha256:${"0".repeat(64)}`,
        } as unknown as AttributedEvent;
        const result = await gateway.submit(submission);
        expect(result.accepted).toBe(false);
        if (!result.accepted) {
          expect(result.path).toBe(`/${field}`);
          expect(result.message).toContain("recorder assigns it");
        }
      });
    }
  });

  describe("clock skew", () => {
    it("accepts a timestamp within tolerance", async () => {
      const result = await gateway.submit(
        attest(alice, { wallTime: new Date(NOW - 60_000).toISOString() }),
      );
      expect(result.accepted).toBe(true);
    });

    it("rejects a timestamp beyond tolerance", async () => {
      // wallTime is inside the signature, so the gateway can only refuse it —
      // and unbounded skew would distort the run clock (ADR-0009).
      const result = await gateway.submit(
        attest(alice, { wallTime: new Date(NOW - 3600_000).toISOString() }),
      );
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.path).toBe("/wallTime");
        expect(result.remediation).toContain("run clock");
      }
    });

    it("rejects a future timestamp beyond tolerance", async () => {
      const result = await gateway.submit(
        attest(alice, { wallTime: new Date(NOW + 3600_000).toISOString() }),
      );
      expect(result.accepted).toBe(false);
    });

    it("rejects an unparseable timestamp", async () => {
      const result = await gateway.submit(attest(alice, { wallTime: "not a date" }));
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.path).toBe("/wallTime");
    });
  });

  describe("subscription", () => {
    const publish = async (
      who: Actor,
      visibility: VisibilityPolicy,
      text: string,
    ): Promise<void> => {
      const result = await gateway.submit(attest(who, { visibility, payload: { text } }));
      expect(result.accepted).toBe(true);
    };

    beforeEach(async () => {
      await publish(alice, { type: "public" }, "public");
      await publish(alice, { type: "controller" }, "controller-only");
      await publish(alice, { type: "channel", channelId: "private-1" }, "channel");
      await publish(
        alice,
        { type: "participants", participantDids: [bob.did] },
        "for-bob",
      );
      await publish(alice, { type: "lineage", terminalHumanDid: "did:key:zRoot" }, "lineage");
      await publish(alice, { type: "post_run_reveal", revealPolicyId: "rp-1" }, "later");
    });

    const texts = async (viewer: Viewer): Promise<string[]> =>
      (await collect(gateway.subscribe(RUN, viewer))).map(
        (e) => (e.payload as { text: string }).text,
      );

    it("shows an outsider only public events", async () => {
      const outsider: Viewer = { did: actor("carol").did, participantType: "agent" };
      expect(await texts(outsider)).toEqual(["public"]);
    });

    it("shows the controller everything", async () => {
      // It already holds the recorder key; withholding would be theatre.
      const controller: Viewer = { did: recorder.did, participantType: "controller" };
      expect(await texts(controller)).toHaveLength(6);
    });

    it("shows an actor its own events regardless of policy", async () => {
      // Otherwise an agent could not audit its own history.
      const self: Viewer = { did: alice.did, participantType: "agent" };
      expect(await texts(self)).toHaveLength(6);
    });

    it("shows channel events to channel members", async () => {
      const member: Viewer = {
        did: bob.did,
        participantType: "agent",
        channelIds: ["private-1"],
      };
      expect(await texts(member)).toContain("channel");
    });

    it("shows participant-scoped events to named participants", async () => {
      const named: Viewer = { did: bob.did, participantType: "agent" };
      expect(await texts(named)).toContain("for-bob");
    });

    it("shows lineage events to a matching root", async () => {
      const kin: Viewer = {
        did: bob.did,
        participantType: "agent",
        terminalHumanDids: ["did:key:zRoot"],
      };
      expect(await texts(kin)).toContain("lineage");
    });

    it("withholds post-run reveals during the run and releases them after", async () => {
      const during: Viewer = { did: bob.did, participantType: "agent" };
      const after: Viewer = { did: bob.did, participantType: "agent", postRun: true };
      expect(await texts(during)).not.toContain("later");
      expect(await texts(after)).toContain("later");
    });

    it("never leaks controller-only events to a participant", async () => {
      const bobView: Viewer = {
        did: bob.did,
        participantType: "agent",
        channelIds: ["private-1"],
        terminalHumanDids: ["did:key:zRoot"],
        postRun: true,
      };
      // Bob is maximally privileged short of being the controller.
      expect(await texts(bobView)).not.toContain("controller-only");
    });

    it("honours fromLogicalTime and limit", async () => {
      const controller: Viewer = { did: recorder.did, participantType: "controller" };
      const events = await collect(
        gateway.subscribe(RUN, controller, { fromLogicalTime: 2, limit: 2 }),
      );
      expect(events.map((e) => e.logicalTime)).toEqual([2, 3]);
    });

    it("yields nothing for an unknown run", async () => {
      const controller: Viewer = { did: recorder.did, participantType: "controller" };
      expect(await collect(gateway.subscribe("run-absent", controller))).toEqual([]);
    });
  });
});

describe("canSee", () => {
  const event = {
    actorDid: "did:key:zActor",
    provenance: { terminalHumanDids: ["did:key:zRoot"] },
  } as never;
  const stranger: Viewer = { did: "did:key:zStranger", participantType: "agent" };

  it("defaults to deny on an unrecognized policy", () => {
    // Failing open would leak controller-only material the first time a new
    // policy type shipped.
    expect(
      canSee({ type: "something_new" } as unknown as VisibilityPolicy, stranger, event),
    ).toBe(false);
  });

  it("treats an absent channel list as no memberships", () => {
    expect(canSee({ type: "channel", channelId: "c1" }, stranger, event)).toBe(false);
  });

  it("treats an absent lineage list as no roots", () => {
    expect(
      canSee({ type: "lineage", terminalHumanDid: "did:key:zRoot" }, stranger, event),
    ).toBe(false);
  });
});
