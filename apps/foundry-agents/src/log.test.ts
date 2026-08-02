/**
 * Regression tests for the event log.
 *
 * A live run produced thirty GAPPED_SEQUENCE violations: `record()` committed a
 * participant's sequence number before signing, so any payload that failed
 * canonicalization burned the number and vanished. The chain then reported lost events
 * forever. Payloads come from language models, so un-canonicalizable input is a normal
 * condition — the log has to survive it without lying about history.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deterministicKeyPair, type KeyPair } from "@freeq-foundry/protocol";
import { FoundryLog } from "./log.js";

describe("FoundryLog", () => {
  let dir: string;
  let log: FoundryLog;
  let actor: KeyPair;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "foundry-log-"));
    actor = deterministicKeyPair("test-actor");
    log = new FoundryLog({
      runId: "test-run",
      path: join(dir, "events.ndjson"),
      recorder: deterministicKeyPair("test-recorder"),
      signers: new Map([[actor.did, actor]]),
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const sequences = (): number[] => log.events.map((event) => event.participantSequence);

  it("keeps sequences gapless when a payload cannot be canonicalized", () => {
    log.record(actor.did, "a", { fine: 1 });
    // `JSON.parse('{"n":1e400}')` yields Infinity, which canonical serialization rejects.
    // An agent discussing valuations writes numbers like this routinely.
    log.record(actor.did, "b", { n: Number.POSITIVE_INFINITY });
    log.record(actor.did, "c", { fine: 2 });

    expect(sequences()).toEqual([1, 2, 3]);
    expect(log.verify().valid).toBe(true);
  });

  it("preserves the failure in the payload rather than dropping the event", () => {
    log.record(actor.did, "big", { blob: "x".repeat(2 * 1024 * 1024) });
    const recorded = log.events[0];
    expect(recorded).toBeDefined();
    // Truncated, not discarded: the event is still in the chain.
    expect(JSON.stringify(recorded?.payload).length).toBeLessThan(64 * 1024);
    expect(log.verify().valid).toBe(true);
  });

  it("coerces every hostile value a model can emit", () => {
    log.record(actor.did, "hostile", {
      nan: Number.NaN,
      inf: Number.NEGATIVE_INFINITY,
      nested: { deep: { arr: [Number.NaN, "ok"] } },
      big: 10n,
      undef: undefined,
    });
    expect(sequences()).toEqual([1]);
    expect(log.verify().valid).toBe(true);
  });

  it("does not consume a sequence for an unknown signer", () => {
    expect(log.record("did:key:stranger", "x", {})).toBeUndefined();
    log.record(actor.did, "y", {});
    expect(sequences()).toEqual([1]);
  });

  it("verifies a multi-actor chain", () => {
    const second = deterministicKeyPair("test-actor-2");
    log.addSigner(second.did, second);
    for (let i = 0; i < 5; i++) {
      log.record(actor.did, "tick", { i });
      log.record(second.did, "tock", { i, bad: Number.NaN });
    }
    const verification = log.verify();
    expect(verification.valid).toBe(true);
    expect(log.events).toHaveLength(10);
  });
});
