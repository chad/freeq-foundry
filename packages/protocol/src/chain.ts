/**
 * Hash-chain and participant-sequence validation.
 *
 * Canonical append order defines logical time. Per-participant sequence numbers
 * make replay and omission *distinguishable* — a gap is a different failure
 * from a duplicate, and the gateway must be able to say which it saw. A system
 * that reports both as "invalid" cannot tell a dropped message from an attack.
 *
 * Spec: §33.4, §33.5.
 */
import { ProtocolError, ProtocolErrorCode } from "./errors.js";
import { computeEventHash } from "./event.js";
import { GENESIS_HASH } from "./hash.js";
import { verifyEvent } from "./event.js";
import type { RecordedEvent } from "./types.js";

/**
 * Tracks per-participant sequence numbers for one run.
 *
 * Sequences start at 1 and increase by exactly one. The distinction between
 * stale (already seen) and gapped (skipped ahead) is the point of this class.
 */
export class SequenceTracker {
  readonly #latest = new Map<string, number>();

  constructor(initial?: Iterable<readonly [string, number]>) {
    if (initial !== undefined) {
      for (const [did, sequence] of initial) this.#latest.set(did, sequence);
    }
  }

  /** Highest accepted sequence for a participant, or 0 if none. */
  latestFor(actorDid: string): number {
    return this.#latest.get(actorDid) ?? 0;
  }

  /**
   * Adopt a participant's sequence without requiring it to start at 1.
   *
   * Used only when verifying a slice that begins mid-run, where what came
   * before is genuinely unknown. Validates the value but not its continuity.
   */
  seed(actorDid: string, sequence: number): ProtocolError | null {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      return new ProtocolError(
        ProtocolErrorCode.MALFORMED_EVENT,
        `participantSequence must be a positive safe integer, received ${sequence}`,
        "/participantSequence",
      );
    }
    this.#latest.set(actorDid, sequence);
    return null;
  }

  /** Check without recording. Returns null when acceptable. */
  check(actorDid: string, sequence: number): ProtocolError | null {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      return new ProtocolError(
        ProtocolErrorCode.MALFORMED_EVENT,
        `participantSequence must be a positive safe integer, received ${sequence}`,
        "/participantSequence",
      );
    }
    const expected = this.latestFor(actorDid) + 1;
    if (sequence < expected) {
      return new ProtocolError(
        ProtocolErrorCode.STALE_SEQUENCE,
        `sequence ${sequence} for ${actorDid} was already accepted; expected ${expected}`,
        "/participantSequence",
      );
    }
    if (sequence > expected) {
      return new ProtocolError(
        ProtocolErrorCode.GAPPED_SEQUENCE,
        `sequence ${sequence} for ${actorDid} skips ${expected}; events may have been lost`,
        "/participantSequence",
      );
    }
    return null;
  }

  /** Check and, if acceptable, record. */
  accept(actorDid: string, sequence: number): ProtocolError | null {
    const error = this.check(actorDid, sequence);
    if (error === null) this.#latest.set(actorDid, sequence);
    return error;
  }

  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.#latest);
  }
}

export interface ChainViolation {
  /** Position in the supplied sequence. */
  readonly index: number;
  readonly eventId: string;
  readonly code: ProtocolErrorCode;
  readonly message: string;
}

export interface ChainVerification {
  readonly valid: boolean;
  readonly checked: number;
  /**
   * Index of the first violation, or -1.
   *
   * Violations are reported precisely, against the events that are actually
   * inconsistent. A naive content edit implicates only the edited event; an
   * edit that also recomputes the hash breaks every later back-link and
   * cascades. Either way, treat the log as untrustworthy from this index
   * onward — that judgement belongs to the caller, not to the checker.
   */
  readonly firstBadIndex: number;
  readonly violations: readonly ChainViolation[];
}

export interface VerifyChainOptions {
  /** Reject events whose runId differs. */
  readonly runId?: string;
  /** Require the first event to anchor at GENESIS_HASH. Default true. */
  readonly expectGenesis?: boolean;
  /**
   * Known per-participant sequence state preceding this slice.
   *
   * When verifying a mid-run slice without this, continuity cannot be checked
   * for a participant's first appearance — the events establishing it are not
   * present. In that case the first sighting is adopted rather than rejected,
   * and continuity is enforced from there. Supplying this map restores full
   * checking.
   */
  readonly initialSequences?: ReadonlyMap<string, number>;
  /** Verify signatures as well as structure. Default true. */
  readonly verifySignatures?: boolean;
  /**
   * DID of the run's recorder, from the run manifest (§53).
   *
   * Without it, content attribution and chain integrity are still checked but
   * the recorder's attestation of *position* is not — so a reordering by a
   * dishonest recorder would go unnoticed (ADR-0008).
   */
  readonly recorderDid?: string;
  /** Stop at the first violation instead of collecting all. Default false. */
  readonly stopOnFirst?: boolean;
}

/**
 * Verify a run's event chain.
 *
 * Recomputes every hash from canonical bytes rather than trusting the declared
 * value, which means every chain verification is also a test of the
 * canonicalizer. Events are expected in canonical append order.
 */
export function verifyChain(
  events: readonly RecordedEvent[],
  options: VerifyChainOptions = {},
): ChainVerification {
  const expectGenesis = options.expectGenesis ?? true;
  const verifySignatures = options.verifySignatures ?? true;
  const stopOnFirst = options.stopOnFirst ?? false;

  const violations: ChainViolation[] = [];
  const seenEventIds = new Set<string>();
  const sequences = new SequenceTracker(options.initialSequences);
  // A slice that does not start at genesis, with no prior state supplied,
  // cannot know what a participant's sequence was before it began.
  const adoptFirstSighting =
    !expectGenesis && options.initialSequences === undefined;

  let previousHash = GENESIS_HASH;
  let previousLogicalTime = -1;
  let checked = 0;

  const record = (index: number, eventId: string, error: ProtocolError): boolean => {
    violations.push({
      index,
      eventId,
      code: error.code,
      message: error.message,
    });
    return stopOnFirst;
  };

  for (const [index, event] of events.entries()) {
    checked++;

    if (options.runId !== undefined && event.runId !== options.runId) {
      if (
        record(
          index,
          event.eventId,
          new ProtocolError(
            ProtocolErrorCode.RUN_MISMATCH,
            `event belongs to run ${event.runId}, expected ${options.runId}`,
            "/runId",
          ),
        )
      )
        break;
    }

    if (seenEventIds.has(event.eventId)) {
      if (
        record(
          index,
          event.eventId,
          new ProtocolError(
            ProtocolErrorCode.DUPLICATE_EVENT_ID,
            `eventId ${event.eventId} appears more than once`,
            "/eventId",
          ),
        )
      )
        break;
    }
    seenEventIds.add(event.eventId);

    if (event.logicalTime <= previousLogicalTime) {
      if (
        record(
          index,
          event.eventId,
          new ProtocolError(
            ProtocolErrorCode.NON_MONOTONIC_LOGICAL_TIME,
            `logicalTime ${event.logicalTime} does not exceed predecessor ${previousLogicalTime}`,
            "/logicalTime",
          ),
        )
      )
        break;
    }
    previousLogicalTime = event.logicalTime;

    const unseenParticipant = sequences.latestFor(event.actorDid) === 0;
    const sequenceError =
      adoptFirstSighting && unseenParticipant
        ? sequences.seed(event.actorDid, event.participantSequence)
        : sequences.accept(event.actorDid, event.participantSequence);
    if (sequenceError !== null) {
      if (record(index, event.eventId, sequenceError)) break;
    }

    // Chain linkage. The genesis anchor is checked only when the caller says
    // this slice starts a run; a partial slice legitimately starts mid-chain.
    if (index === 0) {
      if (expectGenesis && event.previousEventHash !== GENESIS_HASH) {
        if (
          record(
            index,
            event.eventId,
            new ProtocolError(
              ProtocolErrorCode.INVALID_GENESIS,
              `first event must anchor at ${GENESIS_HASH}, found ${event.previousEventHash}`,
              "/previousEventHash",
            ),
          )
        )
          break;
      }
    } else if (event.previousEventHash !== previousHash) {
      if (
        record(
          index,
          event.eventId,
          new ProtocolError(
            ProtocolErrorCode.BROKEN_CHAIN,
            `previousEventHash ${event.previousEventHash} does not match predecessor hash ${previousHash}`,
            "/previousEventHash",
          ),
        )
      )
        break;
    }

    // Recompute rather than trust.
    let recomputed: string | undefined;
    try {
      recomputed = computeEventHash(event);
    } catch (error) {
      if (
        record(
          index,
          event.eventId,
          error instanceof ProtocolError
            ? error
            : new ProtocolError(
                ProtocolErrorCode.MALFORMED_EVENT,
                `event is not canonicalizable: ${String(error)}`,
              ),
        )
      )
        break;
    }

    if (recomputed !== undefined && recomputed !== event.eventHash) {
      if (
        record(
          index,
          event.eventId,
          new ProtocolError(
            ProtocolErrorCode.INVALID_EVENT_HASH,
            `eventHash does not match content: declared ${event.eventHash}, computed ${recomputed}`,
            "/eventHash",
          ),
        )
      )
        break;
    }

    if (verifySignatures) {
      const result = verifyEvent(
        event,
        options.recorderDid === undefined ? {} : { recorderDid: options.recorderDid },
      );
      if (!result.valid) {
        let stop = false;
        for (const error of result.errors) {
          // The hash mismatch is already reported above; do not double-count.
          if (error.code === ProtocolErrorCode.INVALID_EVENT_HASH) continue;
          if (record(index, event.eventId, error)) {
            stop = true;
            break;
          }
        }
        if (stop) break;
      }
    }

    // Advance using the *declared* hash, not the recomputed one.
    //
    // Later events linked to what this event claimed to be, so comparing them
    // against a recomputed value would blame them for their predecessor's
    // corruption. Precision matters in an audit log: a false positive costs as
    // much investigation as a true one.
    previousHash = event.eventHash;
  }

  return {
    valid: violations.length === 0,
    checked,
    firstBadIndex: violations.length === 0 ? -1 : (violations[0] as ChainViolation).index,
    violations,
  };
}
