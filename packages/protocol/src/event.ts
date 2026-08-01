/**
 * Event hashing, sealing, signing, and verification.
 *
 * The two derived byte strings, per ADR-0004:
 *
 *   hashingInput = JCS(event minus "eventHash" minus "signature")
 *   eventHash    = "sha256:" + hex(SHA-256(hashingInput))
 *
 *   signingInput = "FREEQ-FOUNDRY-V1-EVENT\n" + JCS(event minus "signature")
 *   signature    = base64url(Ed25519(signingInput))
 *
 * The hash covers everything but itself and the signature. The signature covers
 * the hash, and therefore transitively covers `previousEventHash` and the whole
 * chain behind it. That is what makes tampering with history detectable rather
 * than merely discouraged.
 *
 * Spec: §33.1, §33.5.
 */
import type { CanonicalValue } from "./canonical.js";
import { ProtocolError, ProtocolErrorCode } from "./errors.js";
import { GENESIS_HASH, hashCanonical, isDigest, type Digest } from "./hash.js";
import { signPayload, verifyPayloadWithDid } from "./signing.js";
import type { DraftEvent, SignedEvent, UnsignedEvent } from "./types.js";

/** Strip `eventHash` and `signature`; the remainder is the hashing input. */
function hashingView(event: Record<string, unknown>): CanonicalValue {
  const { eventHash: _hash, signature: _sig, ...rest } = event;
  return rest as CanonicalValue;
}

/** Strip only `signature`; the remainder is the signing input. */
function signingView(event: Record<string, unknown>): CanonicalValue {
  const { signature: _sig, ...rest } = event;
  return rest as CanonicalValue;
}

/** Compute the canonical hash of an event. */
export function computeEventHash(
  event: UnsignedEvent | SignedEvent | (DraftEvent & { logicalTime: number; previousEventHash: Digest }),
): Digest {
  return hashCanonical(hashingView(event as unknown as Record<string, unknown>));
}

export interface SealOptions {
  /** Position in the run's canonical order. Assigned by the gateway, never by a client. */
  readonly logicalTime: number;
  /** Hash of the preceding event, or {@link GENESIS_HASH} for the first. */
  readonly previousEventHash: Digest;
}

/**
 * Position a draft in the chain and compute its hash.
 *
 * Named "seal" rather than "finalize" because the result is still unsigned: it
 * is fixed in place but not yet attributable.
 */
export function sealEvent<T>(
  draft: DraftEvent<T>,
  options: SealOptions,
): UnsignedEvent<T> {
  if (!Number.isSafeInteger(options.logicalTime) || options.logicalTime < 0) {
    throw new ProtocolError(
      ProtocolErrorCode.MALFORMED_EVENT,
      `logicalTime must be a non-negative safe integer, received ${options.logicalTime}`,
      "/logicalTime",
    );
  }
  if (!isDigest(options.previousEventHash)) {
    throw new ProtocolError(
      ProtocolErrorCode.MALFORMED_EVENT,
      "previousEventHash must be a sha256: digest",
      "/previousEventHash",
    );
  }
  if (!Number.isSafeInteger(draft.participantSequence) || draft.participantSequence < 1) {
    throw new ProtocolError(
      ProtocolErrorCode.MALFORMED_EVENT,
      `participantSequence must be a positive safe integer, received ${draft.participantSequence}`,
      "/participantSequence",
    );
  }

  const positioned = {
    ...draft,
    logicalTime: options.logicalTime,
    previousEventHash: options.previousEventHash,
  };
  const eventHash = hashCanonical(
    hashingView(positioned as unknown as Record<string, unknown>),
  );
  return { ...positioned, eventHash };
}

/** Sign a sealed event. */
export function signEvent<T>(
  event: UnsignedEvent<T>,
  privateKey: Parameters<typeof signPayload>[2],
): SignedEvent<T> {
  const signature = signPayload(
    "EVENT",
    signingView(event as unknown as Record<string, unknown>),
    privateKey,
  );
  return { ...event, signature };
}

/** Seal and sign in one step. */
export function sealAndSignEvent<T>(
  draft: DraftEvent<T>,
  options: SealOptions,
  privateKey: Parameters<typeof signPayload>[2],
): SignedEvent<T> {
  return signEvent(sealEvent(draft, options), privateKey);
}

export interface EventVerification {
  readonly valid: boolean;
  readonly errors: readonly ProtocolError[];
}

export interface VerifyEventOptions {
  /**
   * DID whose key should verify the signature. Defaults to `actorDid`.
   *
   * Overridable because §11.5 allows the signer and the actor to differ — a
   * platform-operated service may sign on behalf of a participant — but the
   * caller must say so explicitly rather than having it inferred.
   */
  readonly signerDid?: string;
}

/**
 * Verify an event's hash and signature.
 *
 * Collects every failure rather than throwing on the first, so a diagnostic can
 * report all of what is wrong instead of one symptom at a time (§13.6).
 */
export function verifyEvent(
  event: SignedEvent,
  options: VerifyEventOptions = {},
): EventVerification {
  const errors: ProtocolError[] = [];

  let recomputed: Digest | undefined;
  try {
    recomputed = hashCanonical(
      hashingView(event as unknown as Record<string, unknown>),
    );
  } catch (error) {
    errors.push(
      error instanceof ProtocolError
        ? error
        : new ProtocolError(
            ProtocolErrorCode.MALFORMED_EVENT,
            `event is not canonicalizable: ${String(error)}`,
          ),
    );
  }

  if (recomputed !== undefined && recomputed !== event.eventHash) {
    errors.push(
      new ProtocolError(
        ProtocolErrorCode.INVALID_EVENT_HASH,
        `eventHash does not match content: declared ${event.eventHash}, computed ${recomputed}`,
        "/eventHash",
      ),
    );
  }

  const signerDid = options.signerDid ?? event.actorDid;
  try {
    const ok = verifyPayloadWithDid(
      "EVENT",
      signingView(event as unknown as Record<string, unknown>),
      event.signature,
      signerDid,
    );
    if (!ok) {
      errors.push(
        new ProtocolError(
          ProtocolErrorCode.INVALID_SIGNATURE,
          `signature does not verify under ${signerDid}`,
          "/signature",
        ),
      );
    }
  } catch (error) {
    errors.push(
      error instanceof ProtocolError
        ? error
        : new ProtocolError(
            ProtocolErrorCode.INVALID_SIGNATURE,
            `signature verification failed: ${String(error)}`,
            "/signature",
          ),
    );
  }

  return { valid: errors.length === 0, errors };
}

export { GENESIS_HASH };
