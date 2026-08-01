import { describe, expect, it } from "vitest";
import { ProtocolErrorCode, isProtocolError } from "./errors.js";
import { generateKeyPair, keyPairFromSeed } from "./keys.js";
import {
  SigningContext,
  signPayload,
  signingInput,
  verifyPayload,
  verifyPayloadWithDid,
  type SignableKind,
} from "./signing.js";

const ALL_KINDS = Object.keys(SigningContext) as SignableKind[];

function expectRejection(fn: () => unknown, code: ProtocolErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(isProtocolError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
    return;
  }
  throw new Error(`expected ${code} but nothing was thrown`);
}

describe("signing", () => {
  it("verifies a signature it produced", () => {
    const { privateKey, publicKey } = generateKeyPair();
    const payload = { a: 1, b: "two" };
    const signature = signPayload("EVENT", payload, privateKey);
    expect(verifyPayload("EVENT", payload, signature, publicKey)).toBe(true);
  });

  it("verifies against the key embedded in a did:key", () => {
    const { privateKey, did } = generateKeyPair();
    const payload = { a: 1 };
    const signature = signPayload("ACTION", payload, privateKey);
    expect(verifyPayloadWithDid("ACTION", payload, signature, did)).toBe(true);
  });

  it("is deterministic, which is what makes byte-exact vectors possible", () => {
    const { privateKey } = keyPairFromSeed(new Uint8Array(32).fill(3));
    const payload = { a: 1, b: [1, 2, 3] };
    expect(signPayload("EVENT", payload, privateKey)).toBe(
      signPayload("EVENT", payload, privateKey),
    );
  });

  it("ignores key insertion order, because the payload is canonicalized", () => {
    const { privateKey, publicKey } = generateKeyPair();
    const signature = signPayload("EVENT", { a: 1, b: 2 }, privateKey);
    expect(verifyPayload("EVENT", { b: 2, a: 1 }, signature, publicKey)).toBe(true);
  });

  it("fails when the payload is altered", () => {
    const { privateKey, publicKey } = generateKeyPair();
    const signature = signPayload("EVENT", { a: 1 }, privateKey);
    expect(verifyPayload("EVENT", { a: 2 }, signature, publicKey)).toBe(false);
  });

  it("fails under a different key", () => {
    const signer = generateKeyPair();
    const other = generateKeyPair();
    const signature = signPayload("EVENT", { a: 1 }, signer.privateKey);
    expect(verifyPayload("EVENT", { a: 1 }, signature, other.publicKey)).toBe(false);
  });
});

describe("domain separation", () => {
  it("gives every payload type a distinct context", () => {
    const contexts = Object.values(SigningContext);
    expect(new Set(contexts).size).toBe(contexts.length);
  });

  it("versions every context, so v2 payloads cannot collide with v1", () => {
    for (const context of Object.values(SigningContext)) {
      expect(context.startsWith("FREEQ-FOUNDRY-V1-")).toBe(true);
      expect(context.endsWith("\n")).toBe(true);
    }
  });

  it("produces different signing input per context for identical payloads", () => {
    const payload = { a: 1 };
    const seen = new Set(
      ALL_KINDS.map((kind) => Buffer.from(signingInput(kind, payload)).toString("hex")),
    );
    expect(seen.size).toBe(ALL_KINDS.length);
  });

  it("rejects a signature replayed into any other context", () => {
    // The whole point of ADR-0005: a signature harvested from one payload type
    // must be worthless everywhere else.
    const { privateKey, publicKey } = generateKeyPair();
    const payload = { a: 1 };

    for (const signedAs of ALL_KINDS) {
      const signature = signPayload(signedAs, payload, privateKey);
      for (const verifiedAs of ALL_KINDS) {
        const expected = signedAs === verifiedAs;
        expect(
          verifyPayload(verifiedAs, payload, signature, publicKey),
          `signed as ${signedAs}, verified as ${verifiedAs}`,
        ).toBe(expected);
      }
    }
  });

  it("prefixes the canonical bytes with the context", () => {
    const input = Buffer.from(signingInput("EVENT", { a: 1 })).toString("utf8");
    expect(input).toBe(`${SigningContext.EVENT}{"a":1}`);
  });
});

describe("signature encoding", () => {
  it("emits unpadded base64url", () => {
    const { privateKey } = generateKeyPair();
    const signature = signPayload("EVENT", { a: 1 }, privateKey);
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(signature).not.toContain("=");
    expect(Buffer.from(signature, "base64url")).toHaveLength(64);
  });

  it("rejects an empty signature", () => {
    const { publicKey } = generateKeyPair();
    expectRejection(
      () => verifyPayload("EVENT", { a: 1 }, "", publicKey),
      ProtocolErrorCode.MISSING_SIGNATURE,
    );
  });

  it("rejects non-base64url characters", () => {
    const { publicKey } = generateKeyPair();
    expectRejection(
      () => verifyPayload("EVENT", { a: 1 }, "abc+def/ghi=", publicKey),
      ProtocolErrorCode.INVALID_SIGNATURE_ENCODING,
    );
  });

  it("rejects a wrong-length signature", () => {
    const { publicKey } = generateKeyPair();
    expectRejection(
      () => verifyPayload("EVENT", { a: 1 }, "AAAA", publicKey),
      ProtocolErrorCode.INVALID_SIGNATURE_ENCODING,
    );
  });
});
