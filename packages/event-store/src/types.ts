/**
 * The event store interface.
 *
 * There is no `update`. There is no `delete`. Corrections happen through new
 * events (§35.3); an interface that cannot express mutation cannot accidentally
 * permit it.
 *
 * The store is the run's **recorder** in the sense of ADR-0008: participants
 * attest content, the store assigns position and attests to it. That is why
 * `append` takes an `AttributedEvent` — content-signed but unpositioned — and
 * returns a `RecordedEvent`. A client that could supply `logicalTime` could
 * reorder history.
 *
 * Spec: §33.4, §34.1, §35.2, §35.3, §36.1. Decisions: ADR-0006, ADR-0008.
 */
import type {
  AttributedEvent,
  ChainVerification,
  Digest,
  ProtocolErrorCode,
  RecordedEvent,
} from "@freeq-foundry/protocol";

/** Outcome of an append. Rejection is an expected condition, not an exception. */
export type AppendResult =
  | { readonly accepted: true; readonly event: RecordedEvent }
  | {
      readonly accepted: false;
      readonly code: ProtocolErrorCode;
      readonly message: string;
      /**
       * The already-stored event, when rejection was a duplicate `eventId`
       * whose content matches. Lets the gateway answer idempotently (§36.9)
       * instead of failing a harmless retry.
       */
      readonly existing?: RecordedEvent;
    };

/** Current tip of a run's chain. */
export interface ChainHead {
  readonly runId: string;
  readonly logicalTime: number;
  readonly eventHash: Digest;
  readonly eventCount: number;
}

export interface ReadOptions {
  /** Inclusive lower bound on `logicalTime`. */
  readonly fromLogicalTime?: number;
  /** Inclusive upper bound on `logicalTime`. */
  readonly toLogicalTime?: number;
  /** Maximum events to yield. */
  readonly limit?: number;
  /** Restrict to one actor. */
  readonly actorDid?: string;
}

export interface VerifyOptions {
  readonly verifySignatures?: boolean;
  readonly stopOnFirst?: boolean;
}

export interface RunRegistration {
  readonly runId: string;
  /**
   * DID whose key attests event position. Must match the store's recorder key.
   *
   * Required rather than defaulted, so a run cannot silently acquire a recorder
   * the manifest never declared.
   */
  readonly recorderDid: string;
}

export interface EventStore {
  /**
   * Register a run before events may be appended to it.
   *
   * §33.4 requires the gateway to reject invalid run IDs, which presupposes a
   * notion of a known run.
   */
  registerRun(registration: RunRegistration): Promise<void>;

  /**
   * Close a run to further appends.
   *
   * Closing is not deletion and does not alter history; it prevents late events
   * from being interleaved into a run whose analysis has begun.
   */
  closeRun(runId: string): Promise<void>;

  /**
   * Append one event.
   *
   * The sole enforcement point for every §33.4 rejection: invalid signature,
   * duplicate event ID, stale or gapped participant sequence, unknown run,
   * malformed payload, oversized event, broken chain.
   */
  append(event: AttributedEvent): Promise<AppendResult>;

  /**
   * Append several events atomically.
   *
   * All-or-nothing: if any event is rejected, none is stored. A partially
   * applied batch would leave a caller unable to say what happened.
   */
  appendBatch(events: readonly AttributedEvent[]): Promise<readonly AppendResult[]>;

  /** Read a run in canonical order. */
  read(runId: string, options?: ReadOptions): AsyncIterable<RecordedEvent>;

  /** Current chain tip, or undefined for an empty or unknown run. */
  head(runId: string): Promise<ChainHead | undefined>;

  /** Highest accepted participant sequence for an actor, or 0. */
  sequenceFor(runId: string, actorDid: string): Promise<number>;

  /** Recompute and verify a run's entire chain. */
  verifyChain(runId: string, options?: VerifyOptions): Promise<ChainVerification>;
}
