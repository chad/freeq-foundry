/**
 * Milestone 1 acceptance criteria, executable.
 *
 * From §50: "deterministic test clients produce a valid replay; mutation is
 * detected; duplicate events are rejected."
 *
 * No model is involved anywhere in this file.
 */
import { describe, expect, it } from "vitest";
import { verifyChain, SequenceTracker } from "./chain.js";
import { ProtocolErrorCode } from "./errors.js";
import { computeEventHash, sealEvent, signEvent, verifyEvent } from "./event.js";
import { GENESIS_HASH } from "./hash.js";
import {
  buildSampleRun,
  parseNdjson,
  testParticipant,
  TestRunBuilder,
} from "./testing.js";
import type { SignedEvent } from "./types.js";

/** Structurally clone an event so a test mutation cannot leak between cases. */
function clone(events: readonly SignedEvent[]): SignedEvent[] {
  return JSON.parse(JSON.stringify(events)) as SignedEvent[];
}

describe("acceptance: deterministic test clients produce a valid replay", () => {
  it("builds a valid chain", () => {
    const run = buildSampleRun();
    const result = verifyChain(run.events, { runId: run.runId });
    expect(result.violations).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(6);
  });

  it("is byte-identical across independent builds", () => {
    // The definition of a deterministic client: same script, same bytes.
    expect(buildSampleRun().toNdjson()).toBe(buildSampleRun().toNdjson());
  });

  it("survives an export and re-import round trip", () => {
    const run = buildSampleRun();
    const exported = run.toNdjson();
    const reimported = parseNdjson(exported);

    expect(reimported).toHaveLength(run.events.length);
    const result = verifyChain(reimported, { runId: run.runId });
    expect(result.violations).toEqual([]);

    // Re-exporting must reproduce the original bytes exactly, or the export
    // format is lossy and the published dataset cannot be trusted.
    expect(reimported.map((e) => JSON.stringify(e)).join("\n")).toBe(exported);
  });

  it("verifies every signature individually", () => {
    for (const event of buildSampleRun().events) {
      expect(verifyEvent(event).valid).toBe(true);
    }
  });

  it("anchors the first event at the genesis hash", () => {
    const [first] = buildSampleRun().events;
    expect(first?.previousEventHash).toBe(GENESIS_HASH);
  });

  it("links every event to its predecessor", () => {
    const events = buildSampleRun().events;
    for (let i = 1; i < events.length; i++) {
      expect(events[i]?.previousEventHash).toBe(events[i - 1]?.eventHash);
    }
  });

  it("advances logical time and per-participant sequence independently", () => {
    const events = buildSampleRun().events;
    expect(events.map((e) => e.logicalTime)).toEqual([0, 1, 2, 3, 4, 5]);
    // Alice acts at logical times 1 and 3; her sequence is 1 then 2.
    const alice = events.filter((e) => e.actorDid === events[1]?.actorDid);
    expect(alice.map((e) => e.participantSequence)).toEqual([1, 2]);
  });
});

describe("acceptance: mutation is detected", () => {
  const cases: Array<{
    name: string;
    mutate: (events: SignedEvent[]) => void;
    expectCode: ProtocolErrorCode;
    expectIndex: number;
  }> = [
    {
      name: "payload altered",
      mutate: (events) => {
        (events[3] as { payload: unknown }).payload = { channelId: "genesis", text: "tampered" };
      },
      expectCode: ProtocolErrorCode.INVALID_EVENT_HASH,
      expectIndex: 3,
    },
    {
      name: "actor reassigned",
      mutate: (events) => {
        (events[4] as { actorDid: string }).actorDid = events[1]?.actorDid as string;
      },
      expectCode: ProtocolErrorCode.INVALID_EVENT_HASH,
      expectIndex: 4,
    },
    {
      name: "declared hash altered",
      mutate: (events) => {
        (events[2] as { eventHash: string }).eventHash = GENESIS_HASH;
      },
      expectCode: ProtocolErrorCode.INVALID_EVENT_HASH,
      expectIndex: 2,
    },
    {
      name: "chain link rewritten",
      mutate: (events) => {
        (events[2] as { previousEventHash: string }).previousEventHash = GENESIS_HASH;
      },
      expectCode: ProtocolErrorCode.BROKEN_CHAIN,
      expectIndex: 2,
    },
    {
      name: "signature swapped between events",
      mutate: (events) => {
        const a = events[1] as { signature: string };
        const b = events[2] as { signature: string };
        [a.signature, b.signature] = [b.signature, a.signature];
      },
      expectCode: ProtocolErrorCode.INVALID_SIGNATURE,
      expectIndex: 1,
    },
    {
      name: "visibility widened",
      mutate: (events) => {
        // Reclassifying controller-only material as public is exactly the
        // attack the hash chain exists to catch (§6.12).
        (events[5] as { visibility: unknown }).visibility = { type: "public" };
      },
      expectCode: ProtocolErrorCode.INVALID_EVENT_HASH,
      expectIndex: 5,
    },
    {
      name: "provenance rewritten to launder attribution",
      mutate: (events) => {
        const event = events[3] as unknown as { provenance: Record<string, unknown> };
        event.provenance = {
          ...event.provenance,
          terminalHumanDids: ["did:key:zSomeoneElse"],
        };
      },
      expectCode: ProtocolErrorCode.INVALID_EVENT_HASH,
      expectIndex: 3,
    },
    {
      name: "event deleted from the middle",
      mutate: (events) => {
        events.splice(3, 1);
      },
      expectCode: ProtocolErrorCode.BROKEN_CHAIN,
      expectIndex: 3,
    },
    {
      name: "events reordered",
      mutate: (events) => {
        const a = events[2] as SignedEvent;
        const b = events[3] as SignedEvent;
        events[2] = b;
        events[3] = a;
      },
      expectCode: ProtocolErrorCode.BROKEN_CHAIN,
      expectIndex: 2,
    },
  ];

  for (const { name, mutate, expectCode, expectIndex } of cases) {
    it(`detects: ${name}`, () => {
      const events = clone(buildSampleRun().events);
      mutate(events);

      const result = verifyChain(events, { runId: "run-sample-001" });
      expect(result.valid).toBe(false);
      expect(result.firstBadIndex).toBe(expectIndex);
      expect(result.violations.map((v) => v.code)).toContain(expectCode);
    });
  }

  it("reports a naive content edit against exactly the edited event", () => {
    // The attacker changes the payload but leaves the declared eventHash
    // alone. Only that event is inconsistent; later events still link
    // correctly to what it claimed to be. Flagging them too would be noise,
    // and in an audit log a false positive is expensive.
    const events = clone(buildSampleRun().events);
    (events[1] as { payload: unknown }).payload = { did: "did:key:zTampered" };

    const result = verifyChain(events, { runId: "run-sample-001" });
    expect(result.valid).toBe(false);
    expect(result.firstBadIndex).toBe(1);
    expect(new Set(result.violations.map((v) => v.index))).toEqual(new Set([1]));
    // Both the hash and the signature give it away, independently.
    expect(result.violations.map((v) => v.code)).toEqual(
      expect.arrayContaining([
        ProtocolErrorCode.INVALID_EVENT_HASH,
        ProtocolErrorCode.INVALID_SIGNATURE,
      ]),
    );
  });

  it("cascades when the attacker makes the edited event self-consistent", () => {
    // The more capable attack: recompute the hash so the event validates on
    // its own. Now the back-link from every later event fails instead, which
    // is the property that makes the chain tamper-evident rather than merely
    // checksummed. Suppressing this cascade would hide the real damage.
    const events = clone(buildSampleRun().events);
    const target = events[1] as { payload: unknown; eventHash: string };
    target.payload = { did: "did:key:zTampered" };
    target.eventHash = computeEventHash(events[1] as SignedEvent);

    const result = verifyChain(events, { runId: "run-sample-001" });
    expect(result.valid).toBe(false);
    expect(result.firstBadIndex).toBe(1);
    // Event 1's signature no longer covers its content, and event 2 onwards
    // no longer chain to it.
    expect(result.violations.map((v) => v.code)).toEqual(
      expect.arrayContaining([
        ProtocolErrorCode.INVALID_SIGNATURE,
        ProtocolErrorCode.BROKEN_CHAIN,
      ]),
    );
    expect(new Set(result.violations.map((v) => v.index)).size).toBeGreaterThan(1);
  });

  it("detects a re-signed event, because the chain no longer matches", () => {
    // The strongest case: an attacker who holds the actor's key can forge one
    // event, but cannot make it fit the chain without rewriting everything
    // after it — which requires every other participant's key too.
    const run = buildSampleRun();
    const events = clone(run.events);
    const victim = testParticipant("alice", "agent");

    const forgedDraft = {
      ...events[3],
      payload: { channelId: "genesis", text: "forged but properly signed" },
    } as unknown as Parameters<typeof sealEvent>[0];

    const forged = signEvent(
      sealEvent(forgedDraft, {
        logicalTime: 3,
        previousEventHash: events[2]?.eventHash as never,
      }),
      victim.keyPair.privateKey,
    );

    events[3] = forged as SignedEvent;

    // The forged event verifies on its own terms...
    expect(verifyEvent(events[3] as SignedEvent).valid).toBe(true);
    // ...but its hash differs, so event 4's back-link no longer matches.
    const result = verifyChain(events, { runId: run.runId });
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.code === ProtocolErrorCode.BROKEN_CHAIN)).toBe(true);
  });
});

describe("acceptance: duplicate events are rejected", () => {
  it("rejects a repeated eventId", () => {
    const events = clone(buildSampleRun().events);
    events.splice(3, 0, events[2] as SignedEvent);

    const result = verifyChain(events, { runId: "run-sample-001" });
    expect(result.valid).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain(
      ProtocolErrorCode.DUPLICATE_EVENT_ID,
    );
  });

  it("distinguishes a stale sequence from a gapped one", () => {
    // Not pedantry: a gap means events may have been lost, a stale value means
    // a replay. Reporting both as "invalid" loses the difference between a
    // network fault and an attack.
    const tracker = new SequenceTracker();
    expect(tracker.accept("did:key:zA", 1)).toBeNull();
    expect(tracker.accept("did:key:zA", 2)).toBeNull();

    expect(tracker.check("did:key:zA", 2)?.code).toBe(ProtocolErrorCode.STALE_SEQUENCE);
    expect(tracker.check("did:key:zA", 1)?.code).toBe(ProtocolErrorCode.STALE_SEQUENCE);
    expect(tracker.check("did:key:zA", 5)?.code).toBe(ProtocolErrorCode.GAPPED_SEQUENCE);
    expect(tracker.check("did:key:zA", 3)).toBeNull();
  });

  it("tracks sequences per participant, not globally", () => {
    const tracker = new SequenceTracker();
    expect(tracker.accept("did:key:zA", 1)).toBeNull();
    expect(tracker.accept("did:key:zB", 1)).toBeNull();
    expect(tracker.latestFor("did:key:zA")).toBe(1);
    expect(tracker.latestFor("did:key:zC")).toBe(0);
  });

  it("rejects a sequence that does not start at 1", () => {
    const tracker = new SequenceTracker();
    expect(tracker.check("did:key:zA", 2)?.code).toBe(ProtocolErrorCode.GAPPED_SEQUENCE);
  });

  it("rejects non-positive and non-integer sequences", () => {
    const tracker = new SequenceTracker();
    expect(tracker.check("did:key:zA", 0)?.code).toBe(ProtocolErrorCode.MALFORMED_EVENT);
    expect(tracker.check("did:key:zA", -1)?.code).toBe(ProtocolErrorCode.MALFORMED_EVENT);
    expect(tracker.check("did:key:zA", 1.5)?.code).toBe(ProtocolErrorCode.MALFORMED_EVENT);
  });

  it("rejects a replayed sequence number inside a run", () => {
    const alice = testParticipant("alice", "agent");
    const builder = new TestRunBuilder("run-dup-001");
    builder.append({ actor: alice, eventType: "a", payload: {} });
    builder.append({ actor: alice, eventType: "b", payload: {} });

    const events = clone(builder.events);
    (events[1] as { participantSequence: number }).participantSequence = 1;

    const result = verifyChain(events, {
      runId: "run-dup-001",
      verifySignatures: false,
    });
    expect(result.violations.map((v) => v.code)).toContain(
      ProtocolErrorCode.STALE_SEQUENCE,
    );
  });
});

describe("acceptance: cross-cutting", () => {
  it("rejects events from a different run", () => {
    const result = verifyChain(buildSampleRun("run-a").events, { runId: "run-b" });
    expect(result.valid).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain(ProtocolErrorCode.RUN_MISMATCH);
  });

  it("rejects non-monotonic logical time", () => {
    const events = clone(buildSampleRun().events);
    (events[2] as { logicalTime: number }).logicalTime = 0;
    const result = verifyChain(events, { verifySignatures: false });
    expect(result.violations.map((v) => v.code)).toContain(
      ProtocolErrorCode.NON_MONOTONIC_LOGICAL_TIME,
    );
  });

  it("verifies a mid-chain slice when genesis is not expected", () => {
    const events = buildSampleRun().events.slice(2);
    expect(verifyChain(events, { expectGenesis: false }).valid).toBe(true);
    expect(verifyChain(events, { expectGenesis: true }).valid).toBe(false);
  });

  it("stops early when asked", () => {
    const events = clone(buildSampleRun().events);
    (events[1] as { payload: unknown }).payload = { tampered: true };
    const result = verifyChain(events, { stopOnFirst: true });
    expect(result.violations).toHaveLength(1);
  });

  it("recomputes hashes rather than trusting them", () => {
    // Every chain verification is therefore also a test of the canonicalizer.
    const [event] = buildSampleRun().events;
    expect(computeEventHash(event as SignedEvent)).toBe(event?.eventHash);
  });
});
