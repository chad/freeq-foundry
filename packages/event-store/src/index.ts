/**
 * @freeq-foundry/event-store
 *
 * The event log is authoritative; all queryable state is a projection of it
 * (§34.1). This package defines the append-only interface and ships the
 * in-memory reference backend plus the conformance suite every backend must
 * pass.
 *
 * Decisions: ADR-0006, ADR-0008.
 */
export type {
  AppendResult,
  ChainHead,
  EventStore,
  ReadOptions,
  RunRegistration,
  VerifyOptions,
} from "./types.js";

export { InMemoryEventStore, type InMemoryEventStoreOptions } from "./memory.js";

export { SqliteEventStore, type SqliteEventStoreOptions } from "./sqlite.js";

export { runEventStoreConformance, type EventStoreHarness } from "./conformance.js";
