/**
 * Two jobs.
 *
 * 1. Drift guard: the committed `vectors/index.json` must equal a fresh build.
 *    A change to canonical form, hashing, or a signing context invalidates every
 *    signature ever issued, so it must never happen by accident.
 * 2. Self-check: this implementation must satisfy every vector it publishes.
 *    Publishing vectors we do not pass would be worse than publishing none.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, canonicalizeToBytes, parseStrict } from "./canonical.js";
import { verifyChain } from "./chain.js";
import { ProtocolError, ProtocolErrorCode } from "./errors.js";
import { hashCanonical, hashString } from "./hash.js";
import { keyPairFromSeed, rawPublicKey, rawPublicKeyFromDidKey } from "./keys.js";
import { SigningContext, signingInput, verifyPayloadWithDid, type SignableKind } from "./signing.js";
import type { RecordedEvent } from "./types.js";
import { applyPatches, buildVectorSet, type VectorSet } from "./vectors.js";

const here = dirname(fileURLToPath(import.meta.url));
const committed = JSON.parse(
  readFileSync(join(here, "..", "vectors", "index.json"), "utf8"),
) as VectorSet;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function codeOf(fn: () => unknown): ProtocolErrorCode | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof ProtocolError ? error.code : undefined;
  }
}

describe("vectors: drift guard", () => {
  it("the committed file matches a fresh build", () => {
    // If this fails, run `pnpm run vectors` — but understand why first. A
    // deliberate protocol change needs a version bump, not a regenerate.
    expect(committed).toEqual(buildVectorSet("@freeq-foundry/protocol"));
  });

  it("declares its format version and protocol id", () => {
    expect(committed.formatVersion).toBe(1);
    expect(committed.protocol).toBe("freeq-foundry/v1");
  });

  it("is non-trivial", () => {
    // A guard that guards nothing passes silently forever.
    expect(committed.canonicalization.valid.length).toBeGreaterThan(10);
    expect(committed.chain.length).toBeGreaterThan(5);
  });

  it("covers every signing context at least once", () => {
    // Coverage, not a count: some contexts warrant more than one vector, and an
    // equality assertion would break every time we added a useful case.
    const covered = new Set(committed.signing.vectors.map((v) => v.kind));
    for (const kind of Object.keys(SigningContext)) {
      expect(covered, `no signing vector for context ${kind}`).toContain(kind);
    }
  });
});

describe("vectors: canonicalization", () => {
  for (const vector of committed.canonicalization.valid) {
    it(`valid: ${vector.name}`, () => {
      const value = parseStrict(vector.inputJson);
      expect(canonicalize(value)).toBe(vector.canonical);
      expect(hex(canonicalizeToBytes(value))).toBe(vector.canonicalHex);
      expect(hashCanonical(value)).toBe(vector.digest);
    });
  }

  for (const vector of committed.canonicalization.invalidJson) {
    it(`invalid: ${vector.name}`, () => {
      expect(
        codeOf(() => canonicalize(parseStrict(vector.inputJson))),
      ).toBe(vector.errorCode);
    });
  }

  it("NFC composed and decomposed forms produce identical bytes", () => {
    const composed = committed.canonicalization.valid.find(
      (v) => v.name === "nfc-composed",
    );
    const decomposed = committed.canonicalization.valid.find(
      (v) => v.name === "nfc-decomposed",
    );
    expect(composed?.canonicalHex).toBe(decomposed?.canonicalHex);
    expect(composed?.digest).toBe(decomposed?.digest);
  });

  // The constructed cases need host-language values JSON cannot express, so the
  // vector file names the condition and each implementation maps it.
  const constructed: Record<string, () => unknown> = {
    nan: () => canonicalize({ n: Number.NaN }),
    "positive-infinity": () => canonicalize({ n: Number.POSITIVE_INFINITY }),
    "undefined-array-element": () => canonicalize([1, undefined, 2] as never),
    "lone-high-surrogate": () => canonicalize({ s: "\ud800" }),
    "lone-low-surrogate": () => canonicalize({ s: "\udc00" }),
  };

  for (const vector of committed.canonicalization.invalidConstructed) {
    it(`invalid constructed: ${vector.name}`, () => {
      const build = constructed[vector.directive];
      expect(build, `no mapping for directive ${vector.directive}`).toBeDefined();
      expect(codeOf(build as () => unknown)).toBe(vector.errorCode);
    });
  }

  it("maps every published directive", () => {
    // A directive nobody implements is a vector nobody can pass.
    for (const vector of committed.canonicalization.invalidConstructed) {
      expect(Object.keys(constructed)).toContain(vector.directive);
    }
  });
});

describe("vectors: digests", () => {
  for (const vector of committed.digests) {
    it(vector.name, () => {
      expect(hashString(vector.inputUtf8)).toBe(vector.digest);
    });
  }
});

describe("vectors: did:key", () => {
  for (const vector of committed.didKey.valid) {
    it(`valid: ${vector.name}`, () => {
      const keyPair = keyPairFromSeed(Buffer.from(vector.seedHex, "hex"));
      expect(hex(rawPublicKey(keyPair.publicKey))).toBe(vector.publicKeyHex);
      expect(keyPair.did).toBe(vector.did);
      // And the DID resolves back to the same key.
      expect(hex(rawPublicKeyFromDidKey(vector.did))).toBe(vector.publicKeyHex);
    });
  }

  for (const vector of committed.didKey.invalid) {
    it(`invalid: ${vector.name}`, () => {
      expect(codeOf(() => rawPublicKeyFromDidKey(vector.did))).toBe(vector.errorCode);
    });
  }

  it("includes the RFC 8032 all-zero-seed vector", () => {
    // Anchors the whole set to an external fact rather than to our own output.
    const zero = committed.didKey.valid.find((v) => v.name === "seed-all-0x00");
    expect(zero?.publicKeyHex).toBe(
      "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29",
    );
  });
});

describe("vectors: signing", () => {
  it("publishes every signing context", () => {
    expect(committed.signing.contexts).toEqual({ ...SigningContext });
  });

  for (const vector of committed.signing.vectors) {
    it(`verifies: ${vector.name}`, () => {
      const payload = parseStrict(vector.payloadJson);
      const keyPair = keyPairFromSeed(Buffer.from(vector.seedHex, "hex"));

      expect(keyPair.did).toBe(vector.did);
      expect(SigningContext[vector.kind]).toBe(vector.context);
      expect(hex(signingInput(vector.kind, payload))).toBe(vector.signingInputHex);
      expect(
        verifyPayloadWithDid(vector.kind, payload, vector.signature, vector.did),
      ).toBe(true);
    });
  }

  it("signing input is the context followed by the canonical payload", () => {
    for (const vector of committed.signing.vectors) {
      const decoded = Buffer.from(vector.signingInputHex, "hex").toString("utf8");
      expect(decoded).toBe(
        vector.context + canonicalize(parseStrict(vector.payloadJson)),
      );
    }
  });

  it("every signature fails under every other context", () => {
    expect(committed.signing.crossContextMustFail).toBe(true);
    const kinds = Object.keys(SigningContext) as SignableKind[];

    for (const vector of committed.signing.vectors) {
      const payload = parseStrict(vector.payloadJson);
      for (const kind of kinds) {
        const expected = kind === vector.kind;
        expect(
          verifyPayloadWithDid(kind, payload, vector.signature, vector.did),
          `${vector.name} signed as ${vector.kind}, verified as ${kind}`,
        ).toBe(expected);
      }
    }
  });
});

describe("vectors: events and chain", () => {
  const events = committed.events.events as RecordedEvent[];

  it("the published run is valid", () => {
    const result = verifyChain(events, {
      runId: committed.events.runId,
      recorderDid: committed.events.recorderDid,
    });
    expect(result.violations).toEqual([]);
  });

  it("the ndjson export round-trips to the same events", () => {
    const lines = committed.events.ndjson.split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(events.length);
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual(events);
    // And re-exporting reproduces the bytes, so the format is not lossy.
    expect(events.map((e) => JSON.stringify(e)).join("\n")).toBe(
      committed.events.ndjson,
    );
  });

  for (const vector of committed.chain) {
    it(`chain: ${vector.name}`, () => {
      const patched = applyPatches(events, vector.patches);
      const result = verifyChain(patched, {
        runId: committed.events.runId,
        recorderDid: committed.events.recorderDid,
      });

      expect(result.valid).toBe(vector.expectValid);
      expect(result.firstBadIndex).toBe(vector.expectFirstBadIndex);
      for (const code of vector.expectCodes) {
        expect(result.violations.map((v) => v.code)).toContain(code);
      }
    });
  }

  it("covers every rejection the chain validator can produce", () => {
    // A validator with an unexercised branch is a validator nobody has tested.
    const published = new Set(committed.chain.flatMap((v) => v.expectCodes));
    for (const code of [
      ProtocolErrorCode.INVALID_EVENT_HASH,
      ProtocolErrorCode.BROKEN_CHAIN,
      ProtocolErrorCode.INVALID_SIGNATURE,
      ProtocolErrorCode.INVALID_RECORDER_SIGNATURE,
      ProtocolErrorCode.STALE_SEQUENCE,
      ProtocolErrorCode.NON_MONOTONIC_LOGICAL_TIME,
    ]) {
      expect(published, `no chain vector exercises ${code}`).toContain(code);
    }
  });
});
