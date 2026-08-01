/**
 * Event attestation: content, position, and record.
 *
 * Two parties make two different claims about every event (ADR-0008):
 *
 *   "I said this."            — the participant, over content only
 *   "This is where it went."  — the recorder, over the positioned event
 *
 * Collapsing them into one signature would lose one of the claims. Keeping them
 * separate means attribution survives a dishonest platform, and ordering
 * survives a dishonest participant.
 *
 *   contentView  = event minus { logicalTime, previousEventHash, eventHash,
 *                                signature, recorderSignature }
 *   signature    = Ed25519_participant("FREEQ-FOUNDRY-V1-EVENT\n"  + JCS(contentView))
 *
 *   hashingInput = event minus { eventHash, recorderSignature }
 *   eventHash    = "sha256:" + hex(SHA-256(hashingInput))
 *
 *   recordView   = event minus { recorderSignature }
 *   recorderSignature
 *                = Ed25519_recorder("FREEQ-FOUNDRY-V1-RECORD\n" + JCS(recordView))
 *
 * Spec: §33.1, §33.5. Decisions: ADR-0004, ADR-0005, ADR-0008.
 */
import type { KeyObject } from "node:crypto";
import type { CanonicalValue } from "./canonical.js";
import { ProtocolError, ProtocolErrorCode } from "./errors.js";
import { GENESIS_HASH, hashCanonical, isDigest, type Digest } from "./hash.js";
import { signPayload, verifyPayloadWithDid } from "./signing.js";
import type {
  AttributedEvent,
  DraftEvent,
  PositionedEvent,
  RecordedEvent,
} from "./types.js";

type AnyRecord = Record<string, unknown>;

/** Content only. Excludes position, so the participant signature is placement-independent. */
function contentView(event: AnyRecord): CanonicalValue {
  const {
    logicalTime: _lt,
    previousEventHash: _peh,
    eventHash: _eh,
    signature: _sig,
    recorderSignature: _rsig,
    ...rest
  } = event;
  return rest as CanonicalValue;
}

/** Everything the hash covers: content, participant signature, and position. */
function hashingView(event: AnyRecord): CanonicalValue {
  const { eventHash: _eh, recorderSignature: _rsig, ...rest } = event;
  return rest as CanonicalValue;
}

/** Everything the recorder signs: the hashing view plus the hash itself. */
function recordView(event: AnyRecord): CanonicalValue {
  const { recorderSignature: _rsig, ...rest } = event;
  return rest as CanonicalValue;
}

/**
 * Participant attestation of content.
 *
 * Can be performed before the recorder has assigned a position, which is what
 * keeps submission one-shot instead of requiring a reservation round-trip.
 */
export function attestEvent<T>(
  draft: DraftEvent<T>,
  participantPrivateKey: KeyObject,
): AttributedEvent<T> {
  assertValidSequence(draft.participantSequence);
  const signature = signPayload(
    "EVENT",
    contentView(draft as unknown as AnyRecord),
    participantPrivateKey,
  );
  return { ...draft, signature };
}

export interface PositionOptions {
  /** Position in the run's canonical order. Assigned by the recorder, never by a client. */
  readonly logicalTime: number;
  /** Hash of the preceding event, or {@link GENESIS_HASH} for the first. */
  readonly previousEventHash: Digest;
}

/** Place an attested event in the chain and compute its hash. */
export function positionEvent<T>(
  event: AttributedEvent<T>,
  options: PositionOptions,
): PositionedEvent<T> {
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
  assertValidSequence(event.participantSequence);

  const positioned = {
    ...event,
    logicalTime: options.logicalTime,
    previousEventHash: options.previousEventHash,
  };
  const eventHash = hashCanonical(hashingView(positioned as unknown as AnyRecord));
  return { ...positioned, eventHash };
}

/** Recorder attestation of position. */
export function recordEvent<T>(
  event: PositionedEvent<T>,
  recorderPrivateKey: KeyObject,
): RecordedEvent<T> {
  const recorderSignature = signPayload(
    "RECORD",
    recordView(event as unknown as AnyRecord),
    recorderPrivateKey,
  );
  return { ...event, recorderSignature };
}

/** Attest, position, and record in one step. */
export function attestPositionAndRecord<T>(
  draft: DraftEvent<T>,
  options: PositionOptions,
  participantPrivateKey: KeyObject,
  recorderPrivateKey: KeyObject,
): RecordedEvent<T> {
  return recordEvent(
    positionEvent(attestEvent(draft, participantPrivateKey), options),
    recorderPrivateKey,
  );
}

/** Compute the canonical hash of a positioned event. */
export function computeEventHash(event: PositionedEvent | RecordedEvent): Digest {
  return hashCanonical(hashingView(event as unknown as AnyRecord));
}

export interface EventVerification {
  readonly valid: boolean;
  /** Did the participant say this? Independent of whether the recorder is honest. */
  readonly contentAttested: boolean;
  /** Has the stored record been altered? */
  readonly hashValid: boolean;
  /** Did the recorder place it here? */
  readonly positionAttested: boolean;
  readonly errors: readonly ProtocolError[];
}

export interface VerifyEventOptions {
  /**
   * DID of the run's recorder, from the run manifest (§53).
   *
   * Required, and deliberately not read from the event: an event that named its
   * own recorder would let a forger name themselves. Omit only to check content
   * attribution alone.
   */
  readonly recorderDid?: string;
  /**
   * DID whose key attested the content. Defaults to `actorDid`.
   *
   * Overridable because §11.5 allows signer and actor to differ, but the caller
   * must say so explicitly rather than having it inferred.
   */
  readonly signerDid?: string;
}

/**
 * Verify an event's three independent claims.
 *
 * Collects every failure rather than throwing on the first, so a diagnostic can
 * report all of what is wrong instead of one symptom at a time (§13.6), and so
 * the three questions stay separately answerable.
 */
export function verifyEvent(
  event: RecordedEvent,
  options: VerifyEventOptions = {},
): EventVerification {
  const errors: ProtocolError[] = [];
  const record = event as unknown as AnyRecord;

  // 1. Has the record been altered?
  let hashValid = false;
  try {
    const recomputed = hashCanonical(hashingView(record));
    hashValid = recomputed === event.eventHash;
    if (!hashValid) {
      errors.push(
        new ProtocolError(
          ProtocolErrorCode.INVALID_EVENT_HASH,
          `eventHash does not match content: declared ${event.eventHash}, computed ${recomputed}`,
          "/eventHash",
        ),
      );
    }
  } catch (error) {
    errors.push(asProtocolError(error, ProtocolErrorCode.MALFORMED_EVENT, "event is not canonicalizable"));
  }

  // 2. Did the participant say this?
  const signerDid = options.signerDid ?? event.actorDid;
  let contentAttested = false;
  try {
    contentAttested = verifyPayloadWithDid(
      "EVENT",
      contentView(record),
      event.signature,
      signerDid,
    );
    if (!contentAttested) {
      errors.push(
        new ProtocolError(
          ProtocolErrorCode.INVALID_SIGNATURE,
          `content signature does not verify under ${signerDid}`,
          "/signature",
        ),
      );
    }
  } catch (error) {
    errors.push(asProtocolError(error, ProtocolErrorCode.INVALID_SIGNATURE, "content signature verification failed", "/signature"));
  }

  // 3. Did the recorder place it here?
  let positionAttested = false;
  if (options.recorderDid === undefined) {
    // Not an error: callers legitimately check attribution alone, for instance
    // when validating a submission before it has been recorded.
    positionAttested = false;
  } else {
    try {
      positionAttested = verifyPayloadWithDid(
        "RECORD",
        recordView(record),
        event.recorderSignature,
        options.recorderDid,
      );
      if (!positionAttested) {
        errors.push(
          new ProtocolError(
            ProtocolErrorCode.INVALID_RECORDER_SIGNATURE,
            `recorder signature does not verify under ${options.recorderDid}`,
            "/recorderSignature",
          ),
        );
      }
    } catch (error) {
      errors.push(asProtocolError(error, ProtocolErrorCode.INVALID_RECORDER_SIGNATURE, "recorder signature verification failed", "/recorderSignature"));
    }
  }

  return {
    valid: errors.length === 0,
    contentAttested,
    hashValid,
    positionAttested,
    errors,
  };
}

function assertValidSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new ProtocolError(
      ProtocolErrorCode.MALFORMED_EVENT,
      `participantSequence must be a positive safe integer, received ${sequence}`,
      "/participantSequence",
    );
  }
}

function asProtocolError(
  error: unknown,
  fallback: ProtocolErrorCode,
  message: string,
  path?: string,
): ProtocolError {
  if (error instanceof ProtocolError) return error;
  return new ProtocolError(fallback, `${message}: ${String(error)}`, path);
}

export { GENESIS_HASH };
