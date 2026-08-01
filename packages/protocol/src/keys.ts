/**
 * Ed25519 keys and `did:key` identifiers.
 *
 * Uses `node:crypto` only. Deterministic key derivation from a 32-byte seed is
 * supported because conformance vectors must be byte-exact, which requires
 * fixed keys.
 *
 * Spec: §11.1, §6.3. Decisions: ADR-0003, ADR-0005.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { base58Decode, base58Encode } from "./base58.js";
import { ProtocolError, ProtocolErrorCode } from "./errors.js";

/** multicodec `ed25519-pub`, varint-encoded. */
const MULTICODEC_ED25519_PUB = Uint8Array.from([0xed, 0x01]);

export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SEED_BYTES = 32;
export const DID_KEY_PREFIX = "did:key:";

/** ASN.1 DER prefix for a PKCS#8-wrapped Ed25519 private key. */
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);

/** ASN.1 DER prefix for an SPKI-wrapped Ed25519 public key. */
const SPKI_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

export interface KeyPair {
  /** `did:key:z...` identifier derived from the public key. */
  readonly did: string;
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

/** Generate a random Ed25519 key pair. */
export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { did: didKeyFromPublicKey(publicKey), publicKey, privateKey };
}

/**
 * Derive a key pair deterministically from a 32-byte seed.
 *
 * The seed is wrapped in PKCS#8 DER and imported, which is the portable way to
 * get a fixed Ed25519 key out of `node:crypto`. Test vectors depend on this
 * being stable.
 */
export function keyPairFromSeed(seed: Uint8Array): KeyPair {
  if (seed.length !== ED25519_SEED_BYTES) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_KEY_LENGTH,
      `Ed25519 seed must be ${ED25519_SEED_BYTES} bytes, received ${seed.length}`,
    );
  }
  const der = new Uint8Array(PKCS8_ED25519_PREFIX.length + seed.length);
  der.set(PKCS8_ED25519_PREFIX, 0);
  der.set(seed, PKCS8_ED25519_PREFIX.length);

  const privateKey = createPrivateKey({
    key: Buffer.from(der),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey);
  return { did: didKeyFromPublicKey(publicKey), publicKey, privateKey };
}

/** Extract the raw 32-byte public key from a KeyObject. */
export function rawPublicKey(publicKey: KeyObject): Uint8Array {
  const spki = publicKey.export({ format: "der", type: "spki" });
  const bytes = new Uint8Array(spki);
  if (
    bytes.length !== SPKI_ED25519_PREFIX.length + ED25519_PUBLIC_KEY_BYTES ||
    !SPKI_ED25519_PREFIX.every((b, i) => bytes[i] === b)
  ) {
    throw new ProtocolError(
      ProtocolErrorCode.UNSUPPORTED_KEY_TYPE,
      "expected an Ed25519 public key",
    );
  }
  return bytes.slice(SPKI_ED25519_PREFIX.length);
}

/** Build a KeyObject from a raw 32-byte Ed25519 public key. */
export function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_KEY_LENGTH,
      `Ed25519 public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes, received ${raw.length}`,
    );
  }
  const der = new Uint8Array(SPKI_ED25519_PREFIX.length + raw.length);
  der.set(SPKI_ED25519_PREFIX, 0);
  der.set(raw, SPKI_ED25519_PREFIX.length);
  return createPublicKey({
    key: Buffer.from(der),
    format: "der",
    type: "spki",
  });
}

/** Encode a public key as `did:key:z...`. */
export function didKeyFromPublicKey(publicKey: KeyObject): string {
  return didKeyFromRaw(rawPublicKey(publicKey));
}

export function didKeyFromRaw(raw: Uint8Array): string {
  if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_KEY_LENGTH,
      `Ed25519 public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes, received ${raw.length}`,
    );
  }
  const multicodec = new Uint8Array(MULTICODEC_ED25519_PUB.length + raw.length);
  multicodec.set(MULTICODEC_ED25519_PUB, 0);
  multicodec.set(raw, MULTICODEC_ED25519_PUB.length);
  // 'z' is the multibase prefix for base58btc.
  return `${DID_KEY_PREFIX}z${base58Encode(multicodec)}`;
}

/**
 * Resolve a `did:key` to its public key.
 *
 * Pure and offline: the key is in the identifier. This is why ADR-0003 puts
 * `did:key` first — no network in the verification path, and no question about
 * which key was valid when.
 */
export function publicKeyFromDidKey(did: string): KeyObject {
  return publicKeyFromRaw(rawPublicKeyFromDidKey(did));
}

export function rawPublicKeyFromDidKey(did: string): Uint8Array {
  if (!did.startsWith(DID_KEY_PREFIX)) {
    const method = did.startsWith("did:") ? did.split(":")[1] : undefined;
    throw new ProtocolError(
      method === undefined
        ? ProtocolErrorCode.INVALID_DID
        : ProtocolErrorCode.UNSUPPORTED_DID_METHOD,
      method === undefined
        ? `not a DID: ${JSON.stringify(did)}`
        : `DID method ${JSON.stringify(method)} is not supported; expected did:key (ADR-0003)`,
    );
  }

  const identifier = did.slice(DID_KEY_PREFIX.length);
  if (!identifier.startsWith("z")) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_DID,
      "did:key identifier must use the base58btc multibase prefix 'z'",
    );
  }

  const decoded = base58Decode(identifier.slice(1));
  if (
    decoded.length !== MULTICODEC_ED25519_PUB.length + ED25519_PUBLIC_KEY_BYTES
  ) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_KEY_LENGTH,
      `did:key payload must be ${MULTICODEC_ED25519_PUB.length + ED25519_PUBLIC_KEY_BYTES} bytes, received ${decoded.length}`,
    );
  }
  if (!MULTICODEC_ED25519_PUB.every((b, i) => decoded[i] === b)) {
    throw new ProtocolError(
      ProtocolErrorCode.UNSUPPORTED_KEY_TYPE,
      "did:key must use the ed25519-pub multicodec (0xed01); other key types are not supported (ADR-0005)",
    );
  }
  return decoded.slice(MULTICODEC_ED25519_PUB.length);
}

export function isDidKey(did: unknown): did is string {
  if (typeof did !== "string") return false;
  try {
    rawPublicKeyFromDidKey(did);
    return true;
  } catch {
    return false;
  }
}
