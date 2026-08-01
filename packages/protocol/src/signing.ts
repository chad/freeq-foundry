/**
 * Signatures — Ed25519 over domain-separated canonical bytes.
 *
 * Eight distinct payload types are signed by the same keys. Without domain
 * separation a signature harvested in one context could be replayed in
 * another, which is a recurring finding in signed-message systems and cheap to
 * prevent here.
 *
 * The API makes misuse structurally hard: `sign` and `verify` take a payload
 * type and derive the context internally. There is no exported function that
 * signs caller-supplied bytes.
 *
 * Spec: §6.4, §56.1. Decision: ADR-0005.
 */
import { sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";
import { canonicalize, type CanonicalValue, type CanonicalizeOptions } from "./canonical.js";
import { ProtocolError, ProtocolErrorCode } from "./errors.js";
import { publicKeyFromDidKey } from "./keys.js";

/**
 * Domain separation contexts, one per signable payload type.
 *
 * The `V1` component means a v2 payload can never collide with a v1 payload
 * under the same key. Changing any of these strings is a breaking protocol
 * change: every previously issued signature stops verifying.
 */
export const SigningContext = {
  EVENT: "FREEQ-FOUNDRY-V1-EVENT\n",
  ACTION: "FREEQ-FOUNDRY-V1-ACTION\n",
  HUMAN_ROOT: "FREEQ-FOUNDRY-V1-HUMAN-ROOT\n",
  AGENT_CREATION: "FREEQ-FOUNDRY-V1-AGENT-CREATION\n",
  TOOL_EXEC: "FREEQ-FOUNDRY-V1-TOOL-EXEC\n",
  EVALUATION: "FREEQ-FOUNDRY-V1-EVALUATION\n",
  CHALLENGE: "FREEQ-FOUNDRY-V1-CHALLENGE\n",
  REVOCATION: "FREEQ-FOUNDRY-V1-REVOCATION\n",
} as const;

export type SigningContext =
  (typeof SigningContext)[keyof typeof SigningContext];

export type SignableKind = keyof typeof SigningContext;

const encoder = new TextEncoder();

/**
 * Build the exact bytes that get signed for a payload.
 *
 * Exported so conformance vectors can assert on the intermediate value: when a
 * signature disagrees across implementations, the first question is always
 * whether the signing input matched.
 */
export function signingInput(
  kind: SignableKind,
  payload: CanonicalValue,
  options?: CanonicalizeOptions,
): Uint8Array {
  const context = SigningContext[kind];
  // Context is ASCII and canonical form is UTF-8, so concatenating the strings
  // before encoding is equivalent to concatenating the encoded bytes.
  return encoder.encode(context + canonicalize(payload, options));
}

/** Sign a payload. Returns an unpadded base64url signature. */
export function signPayload(
  kind: SignableKind,
  payload: CanonicalValue,
  privateKey: KeyObject,
  options?: CanonicalizeOptions,
): string {
  const input = signingInput(kind, payload, options);
  const signature = nodeSign(null, input, privateKey);
  return signature.toString("base64url");
}

/**
 * Verify a signature against a public key.
 *
 * Returns a boolean rather than throwing on cryptographic failure, because an
 * invalid signature is an expected condition the gateway must handle, not an
 * exceptional one. Malformed *encoding* still throws — that is a different
 * kind of wrong.
 */
export function verifyPayload(
  kind: SignableKind,
  payload: CanonicalValue,
  signature: string,
  publicKey: KeyObject,
  options?: CanonicalizeOptions,
): boolean {
  const input = signingInput(kind, payload, options);
  return nodeVerify(null, input, publicKey, decodeSignature(signature));
}

/** Verify against the key embedded in a `did:key` identifier. */
export function verifyPayloadWithDid(
  kind: SignableKind,
  payload: CanonicalValue,
  signature: string,
  did: string,
  options?: CanonicalizeOptions,
): boolean {
  return verifyPayload(
    kind,
    payload,
    signature,
    publicKeyFromDidKey(did),
    options,
  );
}

const ED25519_SIGNATURE_BYTES = 64;

function decodeSignature(signature: string): Buffer {
  if (typeof signature !== "string" || signature.length === 0) {
    throw new ProtocolError(
      ProtocolErrorCode.MISSING_SIGNATURE,
      "signature is absent or empty",
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(signature)) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_SIGNATURE_ENCODING,
      "signature must be unpadded base64url (RFC 4648 section 5)",
    );
  }
  const bytes = Buffer.from(signature, "base64url");
  if (bytes.length !== ED25519_SIGNATURE_BYTES) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_SIGNATURE_ENCODING,
      `Ed25519 signature must be ${ED25519_SIGNATURE_BYTES} bytes, decoded ${bytes.length}`,
    );
  }
  return bytes;
}
