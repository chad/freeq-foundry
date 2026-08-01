import { describe, expect, it } from "vitest";
import { base58Decode, base58Encode } from "./base58.js";
import { ProtocolErrorCode, isProtocolError } from "./errors.js";
import {
  didKeyFromRaw,
  generateKeyPair,
  isDidKey,
  keyPairFromSeed,
  publicKeyFromDidKey,
  rawPublicKey,
  rawPublicKeyFromDidKey,
} from "./keys.js";

function expectRejection(fn: () => unknown, code: ProtocolErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(isProtocolError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
    return;
  }
  throw new Error(`expected ${code} but nothing was thrown`);
}

describe("base58btc", () => {
  it("round-trips arbitrary bytes", () => {
    for (const bytes of [
      new Uint8Array(0),
      Uint8Array.from([0]),
      Uint8Array.from([0, 0, 1]),
      Uint8Array.from([255, 255, 255]),
      Uint8Array.from({ length: 64 }, (_, i) => (i * 37) % 256),
    ]) {
      expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    }
  });

  it("encodes leading zero bytes as literal '1' characters", () => {
    expect(base58Encode(Uint8Array.from([0, 0, 0]))).toBe("111");
    expect(base58Decode("111")).toEqual(Uint8Array.from([0, 0, 0]));
  });

  it("matches known vectors", () => {
    expect(base58Encode(new TextEncoder().encode("Hello World!"))).toBe(
      "2NEpo7TZRRrLZSi2U",
    );
    expect(new TextDecoder().decode(base58Decode("2NEpo7TZRRrLZSi2U"))).toBe(
      "Hello World!",
    );
  });

  it("rejects characters outside the alphabet", () => {
    // '0', 'O', 'I' and 'l' are excluded precisely because they are confusable.
    expectRejection(() => base58Decode("0OIl"), ProtocolErrorCode.INVALID_BASE58);
  });
});

describe("did:key", () => {
  it("derives a stable DID from a fixed seed", () => {
    const seed = new Uint8Array(32).fill(7);
    const a = keyPairFromSeed(seed);
    const b = keyPairFromSeed(seed);
    expect(a.did).toBe(b.did);
    // Determinism is what makes byte-exact conformance vectors possible.
    expect(a.did.startsWith("did:key:z6Mk")).toBe(true);
  });

  it("matches an independently computed vector for an all-zero seed", () => {
    // The Ed25519 public key for a 32-zero-byte seed is the RFC 8032 test
    // vector 3b6a27bc...59da29. The did:key encoding below was cross-checked
    // against a separate base58btc implementation, so this asserts against an
    // external fact rather than against our own output.
    const kp = keyPairFromSeed(new Uint8Array(32));
    expect(Buffer.from(rawPublicKey(kp.publicKey)).toString("hex")).toBe(
      "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29",
    );
    expect(kp.did).toBe(
      "did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp",
    );
  });

  it("round-trips public key to DID and back", () => {
    const { publicKey, did } = generateKeyPair();
    expect(rawPublicKeyFromDidKey(did)).toEqual(rawPublicKey(publicKey));
    expect(rawPublicKey(publicKeyFromDidKey(did))).toEqual(rawPublicKey(publicKey));
  });

  it("rejects a non-DID string", () => {
    expectRejection(() => rawPublicKeyFromDidKey("nonsense"), ProtocolErrorCode.INVALID_DID);
  });

  it("rejects an unsupported DID method", () => {
    expectRejection(
      () => rawPublicKeyFromDidKey("did:web:example.com"),
      ProtocolErrorCode.UNSUPPORTED_DID_METHOD,
    );
  });

  it("rejects a non-base58btc multibase prefix", () => {
    expectRejection(
      () => rawPublicKeyFromDidKey("did:key:mAAAA"),
      ProtocolErrorCode.INVALID_DID,
    );
  });

  it("rejects a wrong-length payload", () => {
    expectRejection(
      () => rawPublicKeyFromDidKey(`did:key:z${base58Encode(Uint8Array.from([0xed, 0x01, 1, 2, 3]))}`),
      ProtocolErrorCode.INVALID_KEY_LENGTH,
    );
  });

  it("rejects a non-Ed25519 multicodec", () => {
    // 0xec01 is x25519-pub: correct length, wrong purpose. Accepting it would
    // mean admitting a key that cannot sign.
    const payload = new Uint8Array(34);
    payload[0] = 0xec;
    payload[1] = 0x01;
    expectRejection(
      () => rawPublicKeyFromDidKey(`did:key:z${base58Encode(payload)}`),
      ProtocolErrorCode.UNSUPPORTED_KEY_TYPE,
    );
  });

  it("rejects a wrong-length raw key", () => {
    expectRejection(
      () => didKeyFromRaw(new Uint8Array(31)),
      ProtocolErrorCode.INVALID_KEY_LENGTH,
    );
  });

  it("rejects a wrong-length seed", () => {
    expectRejection(
      () => keyPairFromSeed(new Uint8Array(16)),
      ProtocolErrorCode.INVALID_KEY_LENGTH,
    );
  });

  it("classifies DIDs without throwing", () => {
    expect(isDidKey(generateKeyPair().did)).toBe(true);
    expect(isDidKey("did:web:example.com")).toBe(false);
    expect(isDidKey(42)).toBe(false);
  });
});
