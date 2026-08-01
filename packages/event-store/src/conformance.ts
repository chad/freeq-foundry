/**
 * The shared event-store conformance suite.
 *
 * Written against the {@link EventStore} interface, never against a particular
 * backend. A backend that diverges from this is broken by definition, and the
 * in-memory implementation is what the suite is written to describe.
 *
 * The in-memory backend's fidelity depends entirely on this suite being
 * thorough: a gap here is a gap in every backend at once (ADR-0006).
 *
 * Exported so the PostgreSQL backend can run it unchanged at Milestone 2.
 */
import {
  ProtocolErrorCode,
  attestEvent,
  isProtocolError,
  type AttributedEvent,
  type DraftEvent,
  type KeyPair,
  type ParticipantType,
} from "@freeq-foundry/protocol";
import { deterministicKeyPair } from "@freeq-foundry/protocol";
import type { EventStore } from "./types.js";

export interface EventStoreHarness {
  /** A fresh, empty store recording as `recorderDid`. */
  createStore(): Promise<EventStore> | EventStore;
  /** DID matching the recorder key the store signs with. */
  readonly recorderDid: string;
}

/** Minimal vitest surface, so this file does not import a test framework. */
interface TestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void): void;
  expect: <T>(actual: T) => {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeUndefined(): void;
    toHaveLength(length: number): void;
    toBeGreaterThan(n: number): void;
    toContain(substring: unknown): void;
  };
}

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
  runId: string,
  who: Actor,
  eventType: string,
  payload: unknown,
  sequence: number,
  eventId?: string,
): DraftEvent {
  return {
    eventId: eventId ?? `${runId}-${who.did.slice(-6)}-${sequence}`,
    runId,
    eventType,
    schemaVersion: 1,
    actorDid: who.did,
    participantType: who.participantType,
    participantSequence: sequence,
    wallTime: "2026-01-01T00:00:00.000Z",
    payload,
    visibility: { type: "public" },
    references: [],
    provenance: {
      signerDid: who.did,
      terminalHumanDids: [who.did],
      provenancePathHashes: [],
      admissionCredentialId: "adm-conformance",
      directInstructionEventIds: [],
      governanceAuthorizationIds: [],
      capabilityGrantIds: [],
    },
  };
}

function attest(
  runId: string,
  who: Actor,
  eventType = "channel.message",
  payload: unknown = { text: "hello" },
  options: { readonly sequence?: number; readonly eventId?: string } = {},
): AttributedEvent {
  const sequence = options.sequence ?? ++who.sequence;
  return attestEvent(
    draft(runId, who, eventType, payload, sequence, options.eventId),
    who.keyPair.privateKey,
  );
}

/**
 * Build an event the SDK would refuse to sign.
 *
 * `attestEvent` canonicalizes before signing, so a participant using this SDK
 * cannot produce a non-canonicalizable or oversized event at all. That is a good
 * property, but it means the store's own defences must be probed the way a
 * hostile client would reach them: by hand-assembling the JSON. The store is an
 * enforcement point, not a convenience layer over a cooperative SDK.
 */
function hostile(
  runId: string,
  who: Actor,
  payload: unknown,
  options: { readonly sequence?: number; readonly eventId?: string } = {},
): AttributedEvent {
  const sequence = options.sequence ?? ++who.sequence;
  return {
    ...draft(runId, who, "hostile", payload, sequence, options.eventId),
    // Well-formed encoding, wrong signature. Canonicalization fails first.
    signature: "A".repeat(86),
  } as AttributedEvent;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

/**
 * Run the suite against a backend.
 *
 * @param api the host test framework's `describe`/`it`/`expect`
 */
export function runEventStoreConformance(
  harness: EventStoreHarness,
  api: TestApi,
): void {
  const { describe, it, expect } = api;

  const RUN = "run-conformance";

  const fresh = async (): Promise<EventStore> => {
    const store = await harness.createStore();
    await store.registerRun({ runId: RUN, recorderDid: harness.recorderDid });
    return store;
  };

  describe("run registration", () => {
    it("rejects appends to an unregistered run", async () => {
      const store = await harness.createStore();
      const alice = actor("alice");
      const result = await store.append(attest("run-nope", alice));
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.code).toBe(ProtocolErrorCode.UNKNOWN_RUN);
    });

    it("rejects a run declaring a recorder the store cannot be", async () => {
      // A run must not silently acquire a recorder its manifest never declared.
      const store = await harness.createStore();
      let threw = false;
      try {
        await store.registerRun({
          runId: "run-x",
          recorderDid: deterministicKeyPair("impostor").did,
        });
      } catch (error) {
        threw = true;
        expect(isProtocolError(error, ProtocolErrorCode.SIGNER_MISMATCH)).toBe(true);
      }
      expect(threw).toBe(true);
    });

    it("rejects registering the same run twice", async () => {
      const store = await fresh();
      let threw = false;
      try {
        await store.registerRun({ runId: RUN, recorderDid: harness.recorderDid });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });

    it("rejects appends to a closed run", async () => {
      const store = await fresh();
      const alice = actor("alice");
      expect((await store.append(attest(RUN, alice))).accepted).toBe(true);
      await store.closeRun(RUN);
      const result = await store.append(attest(RUN, alice));
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.code).toBe(ProtocolErrorCode.RUN_CLOSED);
    });
  });

  describe("append assigns position", () => {
    it("assigns logicalTime from zero, in order", async () => {
      const store = await fresh();
      const alice = actor("alice");
      const times: number[] = [];
      for (let i = 0; i < 4; i++) {
        const result = await store.append(attest(RUN, alice));
        expect(result.accepted).toBe(true);
        if (result.accepted) times.push(result.event.logicalTime);
      }
      expect(times).toEqual([0, 1, 2, 3]);
    });

    it("anchors the first event at the genesis hash and chains thereafter", async () => {
      const store = await fresh();
      const alice = actor("alice");
      const first = await store.append(attest(RUN, alice));
      const second = await store.append(attest(RUN, alice));
      expect(first.accepted && second.accepted).toBe(true);
      if (first.accepted && second.accepted) {
        expect(second.event.previousEventHash).toBe(first.event.eventHash);
      }
    });

    it("attests position with the recorder key", async () => {
      const store = await fresh();
      const result = await store.append(attest(RUN, actor("alice")));
      expect(result.accepted).toBe(true);
      // The chain check verifies the recorder signature, so a store that failed
      // to sign, or signed with the wrong key, cannot pass this.
      expect((await store.verifyChain(RUN)).valid).toBe(true);
    });

    it("keeps a run's chain independent of other runs", async () => {
      const store = await harness.createStore();
      await store.registerRun({ runId: "run-a", recorderDid: harness.recorderDid });
      await store.registerRun({ runId: "run-b", recorderDid: harness.recorderDid });
      const alice = actor("alice");
      const bob = actor("bob");
      await store.append(attest("run-a", alice));
      const inB = await store.append(attest("run-b", bob));
      expect(inB.accepted).toBe(true);
      // run-b's first event anchors at genesis regardless of run-a's contents.
      if (inB.accepted) expect(inB.event.logicalTime).toBe(0);
    });
  });

  describe("append rejects", () => {
    it("a duplicate eventId, answering idempotently", async () => {
      const store = await fresh();
      const alice = actor("alice");
      const event = attest(RUN, alice, "channel.message", { text: "once" });

      const first = await store.append(event);
      expect(first.accepted).toBe(true);

      const retry = await store.append(event);
      expect(retry.accepted).toBe(false);
      if (!retry.accepted) {
        expect(retry.code).toBe(ProtocolErrorCode.DUPLICATE_EVENT_ID);
        // §36.9: a retry after a lost acknowledgement must be answerable, not
        // merely refused.
        expect(retry.existing?.eventHash).toBe(
          first.accepted ? first.event.eventHash : undefined,
        );
      }
    });

    it("a stale participant sequence", async () => {
      const store = await fresh();
      const alice = actor("alice");
      await store.append(attest(RUN, alice, "a", {}, { sequence: 1 }));
      await store.append(attest(RUN, alice, "b", {}, { sequence: 2 }));
      const result = await store.append(
        attest(RUN, alice, "c", {}, { sequence: 2, eventId: "distinct-1" }),
      );
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.code).toBe(ProtocolErrorCode.STALE_SEQUENCE);
    });

    it("a gapped participant sequence, distinctly from a stale one", async () => {
      // A gap means events may have been lost; a stale value means a replay.
      // Collapsing them loses the difference between a fault and an attack.
      const store = await fresh();
      const alice = actor("alice");
      await store.append(attest(RUN, alice, "a", {}, { sequence: 1 }));
      const result = await store.append(
        attest(RUN, alice, "b", {}, { sequence: 5, eventId: "distinct-2" }),
      );
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.code).toBe(ProtocolErrorCode.GAPPED_SEQUENCE);
    });

    it("a sequence that does not begin at one", async () => {
      const store = await fresh();
      const result = await store.append(
        attest(RUN, actor("alice"), "a", {}, { sequence: 2 }),
      );
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.code).toBe(ProtocolErrorCode.GAPPED_SEQUENCE);
    });

    it("a tampered content signature", async () => {
      const store = await fresh();
      const alice = actor("alice");
      const event = attest(RUN, alice);
      const tampered = { ...event, payload: { text: "altered after signing" } };
      const result = await store.append(tampered as AttributedEvent);
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.code).toBe(ProtocolErrorCode.INVALID_SIGNATURE);
    });

    it("an event signed by someone other than the actor", async () => {
      const store = await fresh();
      const alice = actor("alice");
      const mallory = actor("mallory");
      // Mallory signs content that names Alice as the actor.
      const forged = attestEvent(
        draft(RUN, alice, "channel.message", { text: "not mine" }, 1),
        mallory.keyPair.privateKey,
      );
      const result = await store.append(forged);
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.code).toBe(ProtocolErrorCode.INVALID_SIGNATURE);
    });

    it("an oversized event", async () => {
      const store = await fresh();
      const alice = actor("alice");
      const result = await store.append(
        hostile(RUN, alice, { blob: "x".repeat(1_200_000) }),
      );
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.code).toBe(ProtocolErrorCode.SIZE_EXCEEDED);
    });

    it("a payload that is not canonicalizable", async () => {
      const store = await fresh();
      const alice = actor("alice");
      // Floats are forbidden in canonical payloads (ADR-0004).
      const result = await store.append(hostile(RUN, alice, { n: 1.5 }));
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.code).toBe(ProtocolErrorCode.NON_INTEGER_NUMBER);
      }
    });

    it("leaves the chain intact after a rejection", async () => {
      // A rejected append must not consume a logicalTime or advance the chain.
      const store = await fresh();
      const alice = actor("alice");
      await store.append(attest(RUN, alice));
      await store.append(hostile(RUN, alice, { n: 0.5 }, { sequence: 2 }));
      const next = await store.append(attest(RUN, alice));
      expect(next.accepted).toBe(true);
      if (next.accepted) expect(next.event.logicalTime).toBe(1);
      expect((await store.verifyChain(RUN)).valid).toBe(true);
    });
  });

  describe("appendBatch", () => {
    it("appends several events in order", async () => {
      const store = await fresh();
      const alice = actor("alice");
      const results = await store.appendBatch([
        attest(RUN, alice, "a", {}),
        attest(RUN, alice, "b", {}),
        attest(RUN, alice, "c", {}),
      ]);
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.accepted)).toBe(true);
      expect((await store.head(RUN))?.eventCount).toBe(3);
    });

    it("is all-or-nothing", async () => {
      // A partially applied batch would leave the caller unable to say what
      // happened.
      const store = await fresh();
      const alice = actor("alice");
      const results = await store.appendBatch([
        attest(RUN, alice, "a", {}),
        hostile(RUN, alice, { n: 1.25 }),
        attest(RUN, alice, "c", {}),
      ]);
      expect(results.some((r) => !r.accepted)).toBe(true);
      expect(await store.head(RUN)).toBeUndefined();
      expect(await store.sequenceFor(RUN, alice.did)).toBe(0);
    });

    it("leaves the store usable after a failed batch", async () => {
      const store = await fresh();
      const alice = actor("alice");
      await store.appendBatch([
        attest(RUN, alice, "a", {}, { sequence: 1, eventId: "b-1" }),
        hostile(RUN, alice, { n: 1.25 }, { sequence: 2, eventId: "b-2" }),
      ]);
      const after = await store.append(
        attest(RUN, alice, "a", {}, { sequence: 1, eventId: "after-1" }),
      );
      expect(after.accepted).toBe(true);
      if (after.accepted) expect(after.event.logicalTime).toBe(0);
      expect((await store.verifyChain(RUN)).valid).toBe(true);
    });

    it("rejects a batch spanning multiple runs", async () => {
      const store = await fresh();
      await store.registerRun({ runId: "run-other", recorderDid: harness.recorderDid });
      const alice = actor("alice");
      const results = await store.appendBatch([
        attest(RUN, alice, "a", {}),
        attest("run-other", alice, "b", {}),
      ]);
      expect(results.some((r) => !r.accepted)).toBe(true);
    });

    it("accepts an empty batch without effect", async () => {
      const store = await fresh();
      expect(await store.appendBatch([])).toEqual([]);
    });
  });

  describe("concurrency", () => {
    it("assigns distinct positions to concurrent appends", async () => {
      // logicalTime assignment must be serialized. Without a lock, awaiting
      // inside append lets two callers claim the same position.
      const store = await fresh();
      const actors = Array.from({ length: 8 }, (_, i) => actor(`agent-${i}`));
      const results = await Promise.all(
        actors.map((who) => store.append(attest(RUN, who))),
      );
      expect(results.every((r) => r.accepted)).toBe(true);
      const times = results.flatMap((r) => (r.accepted ? [r.event.logicalTime] : []));
      expect(new Set(times).size).toBe(times.length);
      expect((await store.verifyChain(RUN)).valid).toBe(true);
    });

    it("keeps the chain valid under concurrent load from one actor", async () => {
      const store = await fresh();
      const alice = actor("alice");
      // Sequences are pre-assigned, so all eight are individually valid; the
      // store must apply them without breaking linkage.
      const events = Array.from({ length: 8 }, (_, i) =>
        attest(RUN, alice, "m", { i }, { sequence: i + 1, eventId: `seq-${i + 1}` }),
      );
      await Promise.all(events.map((e) => store.append(e)));
      const verification = await store.verifyChain(RUN);
      expect(verification.valid).toBe(true);
      expect(await store.sequenceFor(RUN, alice.did)).toBe(8);
    });
  });

  describe("read", () => {
    const seed = async (): Promise<{
      store: EventStore;
      alice: Actor;
      bob: Actor;
    }> => {
      const store = await fresh();
      const alice = actor("alice");
      const bob = actor("bob");
      for (let i = 0; i < 3; i++) {
        await store.append(attest(RUN, alice, "a", { i }));
        await store.append(attest(RUN, bob, "b", { i }));
      }
      return { store, alice, bob };
    };

    it("yields events in canonical order", async () => {
      const { store } = await seed();
      const events = await collect(store.read(RUN));
      expect(events.map((e) => e.logicalTime)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("honours logical-time bounds inclusively", async () => {
      const { store } = await seed();
      const events = await collect(
        store.read(RUN, { fromLogicalTime: 2, toLogicalTime: 4 }),
      );
      expect(events.map((e) => e.logicalTime)).toEqual([2, 3, 4]);
    });

    it("honours a limit", async () => {
      const { store } = await seed();
      expect(await collect(store.read(RUN, { limit: 2 }))).toHaveLength(2);
    });

    it("filters by actor", async () => {
      const { store, alice } = await seed();
      const events = await collect(store.read(RUN, { actorDid: alice.did }));
      expect(events).toHaveLength(3);
      expect(events.every((e) => e.actorDid === alice.did)).toBe(true);
    });

    it("yields nothing for an unknown run rather than throwing", async () => {
      const store = await fresh();
      expect(await collect(store.read("run-absent"))).toEqual([]);
    });
  });

  describe("head and sequenceFor", () => {
    it("reports undefined head for an empty run", async () => {
      const store = await fresh();
      expect(await store.head(RUN)).toBeUndefined();
    });

    it("reports undefined head for an unknown run", async () => {
      const store = await fresh();
      expect(await store.head("run-absent")).toBeUndefined();
    });

    it("tracks the chain tip", async () => {
      const store = await fresh();
      const alice = actor("alice");
      await store.append(attest(RUN, alice));
      const last = await store.append(attest(RUN, alice));
      const head = await store.head(RUN);
      expect(head?.eventCount).toBe(2);
      expect(head?.logicalTime).toBe(1);
      if (last.accepted) expect(head?.eventHash).toBe(last.event.eventHash);
    });

    it("tracks sequences per actor, not globally", async () => {
      const store = await fresh();
      const alice = actor("alice");
      const bob = actor("bob");
      await store.append(attest(RUN, alice));
      await store.append(attest(RUN, alice));
      await store.append(attest(RUN, bob));
      expect(await store.sequenceFor(RUN, alice.did)).toBe(2);
      expect(await store.sequenceFor(RUN, bob.did)).toBe(1);
      expect(await store.sequenceFor(RUN, actor("carol").did)).toBe(0);
    });

    it("reports zero for an unknown run", async () => {
      const store = await fresh();
      expect(await store.sequenceFor("run-absent", actor("alice").did)).toBe(0);
    });
  });

  describe("verifyChain", () => {
    it("verifies an empty run", async () => {
      const store = await fresh();
      expect((await store.verifyChain(RUN)).valid).toBe(true);
    });

    it("verifies a populated run and recomputes every hash", async () => {
      const store = await fresh();
      const alice = actor("alice");
      for (let i = 0; i < 5; i++) await store.append(attest(RUN, alice));
      const verification = await store.verifyChain(RUN);
      expect(verification.valid).toBe(true);
      expect(verification.checked).toBe(5);
      expect(verification.firstBadIndex).toBe(-1);
    });

    it("throws for an unknown run", async () => {
      const store = await fresh();
      let threw = false;
      try {
        await store.verifyChain("run-absent");
      } catch (error) {
        threw = true;
        expect(isProtocolError(error, ProtocolErrorCode.UNKNOWN_RUN)).toBe(true);
      }
      expect(threw).toBe(true);
    });
  });

  describe("immutability", () => {
    it("exposes no mutation surface", async () => {
      // §35.3: corrections happen through new events. An interface that cannot
      // express mutation cannot accidentally permit it.
      const store = await fresh();
      const surface = store as unknown as Record<string, unknown>;
      for (const forbidden of ["update", "delete", "remove", "truncate", "set"]) {
        expect(typeof surface[forbidden]).toBe("undefined");
      }
    });

    it("does not let a caller mutate stored events through a read", async () => {
      const store = await fresh();
      const alice = actor("alice");
      await store.append(attest(RUN, alice, "m", { text: "original" }));

      const [event] = await collect(store.read(RUN));
      let refused = false;
      try {
        (event as unknown as { payload: unknown }).payload = { text: "mutated" };
      } catch {
        // Frozen. The strongest available guarantee, and the one we want.
        refused = true;
      }
      expect(refused).toBe(true);

      // And regardless, the store's own copy must still verify.
      expect((await store.verifyChain(RUN)).valid).toBe(true);
    });
  });
}
