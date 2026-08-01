/**
 * In-memory event store.
 *
 * The reference implementation. If a rejection rule is not enforced here, it
 * does not exist — the shared conformance suite is written against this, and the
 * PostgreSQL backend inherits it unchanged (ADR-0006).
 *
 * Spec: §33.4, §34.1, §35.3.
 */
import {
  GENESIS_HASH,
  ProtocolError,
  ProtocolErrorCode,
  SequenceTracker,
  canonicalizeToBytes,
  positionEvent,
  recordEvent,
  verifyChain as verifyChainOf,
  verifyEvent,
  type AttributedEvent,
  type ChainVerification,
  type Digest,
  type RecordedEvent,
} from "@freeq-foundry/protocol";
import type { KeyObject } from "node:crypto";
import type {
  AppendResult,
  ChainHead,
  EventStore,
  ReadOptions,
  RunRegistration,
  VerifyOptions,
} from "./types.js";

/** Maximum canonical size of a single event, per ADR-0004. */
const MAX_EVENT_BYTES = 1024 * 1024;

interface RunState {
  readonly runId: string;
  readonly recorderDid: string;
  readonly events: RecordedEvent[];
  readonly byEventId: Map<string, RecordedEvent>;
  readonly sequences: SequenceTracker;
  previousEventHash: Digest;
  nextLogicalTime: number;
  closed: boolean;
}

export interface InMemoryEventStoreOptions {
  /** DID of the recorder. Must match `recorderPrivateKey`. */
  readonly recorderDid: string;
  readonly recorderPrivateKey: KeyObject;
}

export class InMemoryEventStore implements EventStore {
  readonly #runs = new Map<string, RunState>();
  readonly #recorderDid: string;
  readonly #recorderPrivateKey: KeyObject;
  /**
   * Serializes appends per run.
   *
   * `logicalTime` assignment must be serialized (ADR-0006). Awaiting inside
   * `append` yields the event loop, so without this two concurrent appends can
   * interleave and both claim the same position. This is the in-memory analogue
   * of the PostgreSQL backend's per-run transaction ordering.
   */
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(options: InMemoryEventStoreOptions) {
    this.#recorderDid = options.recorderDid;
    this.#recorderPrivateKey = options.recorderPrivateKey;
  }

  get recorderDid(): string {
    return this.#recorderDid;
  }

  async registerRun(registration: RunRegistration): Promise<void> {
    if (registration.recorderDid !== this.#recorderDid) {
      throw new ProtocolError(
        ProtocolErrorCode.SIGNER_MISMATCH,
        `run ${registration.runId} declares recorder ${registration.recorderDid}, ` +
          `but this store records as ${this.#recorderDid}`,
      );
    }
    if (this.#runs.has(registration.runId)) {
      throw new ProtocolError(
        ProtocolErrorCode.MALFORMED_EVENT,
        `run ${registration.runId} is already registered`,
      );
    }
    this.#runs.set(registration.runId, {
      runId: registration.runId,
      recorderDid: registration.recorderDid,
      events: [],
      byEventId: new Map(),
      sequences: new SequenceTracker(),
      previousEventHash: GENESIS_HASH,
      nextLogicalTime: 0,
      closed: false,
    });
  }

  async closeRun(runId: string): Promise<void> {
    const run = this.#runs.get(runId);
    if (run === undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.UNKNOWN_RUN,
        `run ${runId} is not registered`,
      );
    }
    run.closed = true;
  }

  append(event: AttributedEvent): Promise<AppendResult> {
    return this.#serialized(event.runId, () => this.#appendNow(event));
  }

  appendBatch(
    events: readonly AttributedEvent[],
  ): Promise<readonly AppendResult[]> {
    if (events.length === 0) return Promise.resolve([]);

    const runIds = new Set(events.map((e) => e.runId));
    if (runIds.size > 1) {
      return Promise.resolve([
        {
          accepted: false as const,
          code: ProtocolErrorCode.RUN_MISMATCH,
          message: `a batch must target one run, found ${runIds.size}`,
        },
      ]);
    }
    const runId = events[0]?.runId as string;

    return this.#serialized(runId, () => {
      const run = this.#runs.get(runId);
      // Snapshot enough state to roll back. All-or-nothing: a partially applied
      // batch would leave the caller unable to say what happened.
      const rollback =
        run === undefined
          ? undefined
          : {
              length: run.events.length,
              previousEventHash: run.previousEventHash,
              nextLogicalTime: run.nextLogicalTime,
              sequences: run.sequences.snapshot(),
            };

      const results: AppendResult[] = [];
      for (const event of events) {
        const result = this.#appendNow(event);
        results.push(result);
        if (!result.accepted) {
          if (run !== undefined && rollback !== undefined) {
            for (const applied of results) {
              if (applied.accepted) run.byEventId.delete(applied.event.eventId);
            }
            run.events.length = rollback.length;
            run.previousEventHash = rollback.previousEventHash;
            run.nextLogicalTime = rollback.nextLogicalTime;
            run.sequences.reset(rollback.sequences);
          }
          return [result];
        }
      }
      return results;
    });
  }

  #appendNow(event: AttributedEvent): AppendResult {
    const run = this.#runs.get(event.runId);
    if (run === undefined) {
      return reject(
        ProtocolErrorCode.UNKNOWN_RUN,
        `run ${event.runId} is not registered`,
      );
    }
    if (run.closed) {
      return reject(
        ProtocolErrorCode.RUN_CLOSED,
        `run ${event.runId} is closed to further appends`,
      );
    }

    // Duplicate eventId. Checked before anything expensive, and answered
    // idempotently when the content matches (§36.9) so a retry after a lost
    // acknowledgement is harmless rather than an error.
    const existing = run.byEventId.get(event.eventId);
    if (existing !== undefined) {
      return {
        accepted: false,
        code: ProtocolErrorCode.DUPLICATE_EVENT_ID,
        message: `eventId ${event.eventId} was already accepted at logicalTime ${existing.logicalTime}`,
        existing,
      };
    }

    // Size, measured on canonical bytes rather than on a guess.
    try {
      const bytes = canonicalizeToBytes(event as never);
      if (bytes.byteLength > MAX_EVENT_BYTES) {
        return reject(
          ProtocolErrorCode.SIZE_EXCEEDED,
          `event is ${bytes.byteLength} canonical bytes, limit is ${MAX_EVENT_BYTES}`,
        );
      }
    } catch (error) {
      return reject(
        error instanceof ProtocolError ? error.code : ProtocolErrorCode.MALFORMED_EVENT,
        error instanceof Error ? error.message : String(error),
      );
    }

    // Participant sequence: stale and gapped stay distinct, because a gap means
    // events may have been lost and a stale value means a replay.
    const sequenceError = run.sequences.check(
      event.actorDid,
      event.participantSequence,
    );
    if (sequenceError !== null) {
      return reject(sequenceError.code, sequenceError.message);
    }

    // Position and record. The store is the recorder (ADR-0008).
    let recorded: RecordedEvent;
    try {
      recorded = recordEvent(
        positionEvent(event, {
          logicalTime: run.nextLogicalTime,
          previousEventHash: run.previousEventHash,
        }),
        this.#recorderPrivateKey,
      );
    } catch (error) {
      return reject(
        error instanceof ProtocolError ? error.code : ProtocolErrorCode.MALFORMED_EVENT,
        error instanceof Error ? error.message : String(error),
      );
    }

    // Verify what we are about to store, including the content attestation we
    // did not produce. A store that trusts its input is not an enforcement
    // point.
    const verification = verifyEvent(recorded, { recorderDid: this.#recorderDid });
    if (!verification.valid) {
      const first = verification.errors[0] as ProtocolError;
      return reject(first.code, first.message);
    }

    // Freeze before storing. §35.3 forbids mutating canonical events, and an
    // in-memory store that hands out live references cannot honour that: a
    // caller reading an event could silently rewrite history. Freezing makes
    // the attempt throw instead, and costs nothing on read since the frozen
    // object can be shared rather than copied.
    const stored = deepFreeze(recorded);

    run.sequences.accept(event.actorDid, event.participantSequence);
    run.events.push(stored);
    run.byEventId.set(stored.eventId, stored);
    run.previousEventHash = stored.eventHash;
    run.nextLogicalTime++;

    return { accepted: true, event: stored };
  }

  async *read(runId: string, options: ReadOptions = {}): AsyncIterable<RecordedEvent> {
    const run = this.#runs.get(runId);
    if (run === undefined) return;

    const from = options.fromLogicalTime ?? 0;
    const to = options.toLogicalTime ?? Number.MAX_SAFE_INTEGER;
    let yielded = 0;

    for (const event of run.events) {
      if (event.logicalTime < from || event.logicalTime > to) continue;
      if (options.actorDid !== undefined && event.actorDid !== options.actorDid) continue;
      yield event;
      yielded++;
      if (options.limit !== undefined && yielded >= options.limit) return;
    }
  }

  async head(runId: string): Promise<ChainHead | undefined> {
    const run = this.#runs.get(runId);
    if (run === undefined || run.events.length === 0) return undefined;
    const last = run.events[run.events.length - 1] as RecordedEvent;
    return {
      runId,
      logicalTime: last.logicalTime,
      eventHash: last.eventHash,
      eventCount: run.events.length,
    };
  }

  async sequenceFor(runId: string, actorDid: string): Promise<number> {
    return this.#runs.get(runId)?.sequences.latestFor(actorDid) ?? 0;
  }

  async verifyChain(
    runId: string,
    options: VerifyOptions = {},
  ): Promise<ChainVerification> {
    const run = this.#runs.get(runId);
    if (run === undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.UNKNOWN_RUN,
        `run ${runId} is not registered`,
      );
    }
    return verifyChainOf(run.events, {
      runId,
      recorderDid: this.#recorderDid,
      verifySignatures: options.verifySignatures ?? true,
      stopOnFirst: options.stopOnFirst ?? false,
    });
  }

  /** Serialize work per run, so concurrent appends cannot claim one position. */
  async #serialized<T>(runId: string, work: () => T): Promise<T> {
    const previous = this.#locks.get(runId) ?? Promise.resolve();
    const current = previous.then(work, work);
    this.#locks.set(
      runId,
      current.catch(() => undefined),
    );
    return current;
  }
}

function reject(code: ProtocolErrorCode, message: string): AppendResult {
  return { accepted: false, code, message };
}

/** Recursively freeze an object graph. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
