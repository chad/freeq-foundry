import { describe, expect, it } from "vitest";
import { deterministicKeyPair } from "@freeq-foundry/protocol";
import { runEventStoreConformance } from "./conformance.js";
import { InMemoryEventStore } from "./memory.js";

const recorder = deterministicKeyPair("recorder");

describe("InMemoryEventStore", () => {
  runEventStoreConformance(
    {
      recorderDid: recorder.did,
      createStore: () =>
        new InMemoryEventStore({
          recorderDid: recorder.did,
          recorderPrivateKey: recorder.privateKey,
        }),
    },
    { describe, it, expect: expect as never },
  );
});
