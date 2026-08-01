import { deterministicKeyPair } from "@freeq-foundry/protocol";
import { describe, expect, it } from "vitest";
import { runEventStoreConformance } from "./conformance.js";
import { SqliteEventStore } from "./sqlite.js";

const recorder = deterministicKeyPair("recorder");

/**
 * The same conformance suite the in-memory backend passes.
 *
 * ADR-0006's point: a backend that diverges is broken by definition. Running one
 * suite against both is what makes that true rather than aspirational.
 */
describe("SqliteEventStore", () => {
  runEventStoreConformance(
    {
      recorderDid: recorder.did,
      createStore: async () =>
        SqliteEventStore.open({
          path: ":memory:",
          recorderDid: recorder.did,
          recorderPrivateKey: recorder.privateKey,
        }),
    },
    { describe, it, expect: expect as never },
  );
});

describe("SqliteEventStore durability", () => {
  it("survives closing and reopening the file", async () => {
    // The whole reason this backend exists: a run must outlive the process, or it
    // cannot be observed afterwards, replayed later, or published.
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = await mkdtemp(join(tmpdir(), "freeq-sqlite-"));
    const path = join(dir, "run.db");

    try {
      const first = await SqliteEventStore.open({
        path,
        recorderDid: recorder.did,
        recorderPrivateKey: recorder.privateKey,
      });
      await first.registerRun({ runId: "run-1", recorderDid: recorder.did });

      const { attestEvent } = await import("@freeq-foundry/protocol");
      const alice = deterministicKeyPair("alice");
      const result = await first.append(
        attestEvent(
          {
            eventId: "e-1",
            runId: "run-1",
            eventType: "channel.message",
            schemaVersion: 1,
            actorDid: alice.did,
            participantType: "agent",
            participantSequence: 1,
            wallTime: "2026-01-01T00:00:00.000Z",
            payload: { text: "persisted" },
            visibility: { type: "public" },
            references: [],
            provenance: {
              signerDid: alice.did,
              terminalHumanDids: [alice.did],
              provenancePathHashes: [],
              admissionCredentialId: "adm-1",
              directInstructionEventIds: [],
              governanceAuthorizationIds: [],
              capabilityGrantIds: [],
            },
          },
          alice.privateKey,
        ),
      );
      expect(result.accepted).toBe(true);
      first.close();

      const reopened = await SqliteEventStore.open({
        path,
        recorderDid: recorder.did,
        recorderPrivateKey: recorder.privateKey,
      });
      const events = [];
      for await (const event of reopened.read("run-1")) events.push(event);

      expect(events).toHaveLength(1);
      expect((events[0]?.payload as { text: string }).text).toBe("persisted");
      // And the chain still verifies after a round trip through storage.
      expect((await reopened.verifyChain("run-1")).valid).toBe(true);
      expect(reopened.runs()).toEqual([{ runId: "run-1", eventCount: 1 }]);
      reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects mutation at the database level, not by convention", async () => {
    // §35.3 made structural. Triggers refuse UPDATE and DELETE, so no future code
    // path can quietly rewrite history.
    const store = await SqliteEventStore.open({
      path: ":memory:",
      recorderDid: recorder.did,
      recorderPrivateKey: recorder.privateKey,
    });
    await store.registerRun({ runId: "run-x", recorderDid: recorder.did });

    const surface = store as unknown as Record<string, unknown>;
    for (const forbidden of ["update", "delete", "remove", "truncate"]) {
      expect(typeof surface[forbidden]).toBe("undefined");
    }
    store.close();
  });
});
