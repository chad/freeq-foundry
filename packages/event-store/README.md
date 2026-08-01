# @freeq-foundry/event-store

The event log is authoritative; all queryable state is a projection of it
([§34.1](../../docs/specification.md#341-principle)). This package defines the
append-only interface, ships the in-memory reference backend, and exports the
conformance suite every backend must pass
([ADR-0006](../../docs/adr/0006-event-store-backend.md)).

## No mutation surface

```typescript
interface EventStore {
  registerRun(registration: RunRegistration): Promise<void>;
  closeRun(runId: string): Promise<void>;
  append(event: AttributedEvent): Promise<AppendResult>;
  appendBatch(events: readonly AttributedEvent[]): Promise<readonly AppendResult[]>;
  read(runId: string, options?: ReadOptions): AsyncIterable<RecordedEvent>;
  head(runId: string): Promise<ChainHead | undefined>;
  sequenceFor(runId: string, actorDid: string): Promise<number>;
  verifyChain(runId: string, options?: VerifyOptions): Promise<ChainVerification>;
}
```

There is no `update`. There is no `delete`. Corrections happen through new events
([§35.3](../../docs/specification.md#353-immutable-writes)) — an interface that
cannot express mutation cannot accidentally permit it.

## The store is the recorder

`append` takes an `AttributedEvent` — content-signed by the participant but
**unpositioned** — and returns a `RecordedEvent`. The store assigns `logicalTime`,
links the chain, and adds its own recorder attestation
([ADR-0008](../../docs/adr/0008-event-authorship.md)).

A client cannot supply `logicalTime`, because a client that could would be able
to reorder history.

This is also why the API shape works at all: the participant signs content only,
so it does not need to know its position in advance, and submission stays one-shot
rather than requiring a position reservation.

## Rejections

`append` is the sole enforcement point for
[§33.4](../../docs/specification.md#334-event-ordering). Each rejection carries a
distinct code:

| Code | Cause |
| --- | --- |
| `UNKNOWN_RUN` | Run not registered |
| `RUN_CLOSED` | Run closed to further appends |
| `DUPLICATE_EVENT_ID` | Already accepted — answered idempotently, see below |
| `STALE_SEQUENCE` | Sequence already used: a replay |
| `GAPPED_SEQUENCE` | Sequence skipped ahead: events may have been lost |
| `SIZE_EXCEEDED` | Over 1 MiB of canonical bytes |
| `NON_INTEGER_NUMBER` etc. | Payload is not canonicalizable |
| `INVALID_SIGNATURE` | Content attestation does not verify under `actorDid` |

Stale and gapped stay distinct deliberately. A gap means events may have been
lost; a stale value means a replay. Collapsing them loses the difference between
a network fault and an attack.

A rejected append consumes no `logicalTime` and does not advance the chain.

### Idempotent duplicates

A repeated `eventId` is rejected, but the result carries the already-stored event:

```typescript
const result = await store.append(event);
if (!result.accepted && result.code === "DUPLICATE_EVENT_ID") {
  result.existing; // the event as recorded
}
```

This lets the gateway answer a retry after a lost acknowledgement
([§36.9](../../docs/specification.md#369-api-idempotency)) instead of failing a
harmless one.

## `appendBatch` is all-or-nothing

If any event in a batch is rejected, none is stored and the run's chain, sequence
state, and next position are rolled back. A partially applied batch would leave
the caller unable to say what happened.

## Concurrency

`logicalTime` assignment is serialized per run. Without that, `await` inside
`append` lets two concurrent callers claim the same position — the in-memory
analogue of the PostgreSQL backend's per-run transaction ordering.

## Stored events are frozen

Events are deep-frozen before storage. An in-memory store that hands out live
references cannot honour
[§35.3](../../docs/specification.md#353-immutable-writes): a caller reading an
event could silently rewrite history. Freezing makes the attempt throw, and costs
nothing on read since the frozen object is shared rather than copied.

This was a real bug, caught by the conformance suite.

## Conformance

```typescript
import { describe, expect, it } from "vitest";
import { runEventStoreConformance } from "@freeq-foundry/event-store";

runEventStoreConformance(
  { recorderDid, createStore: () => new MyBackend(...) },
  { describe, it, expect },
);
```

39 tests, written against the interface rather than any backend. The PostgreSQL
backend at Milestone 2 inherits them unchanged.

Note how the malformed-payload tests work: `attestEvent` canonicalizes before
signing, so a participant using the SDK **cannot** produce a non-canonicalizable
or oversized event. That is a good property, but it means the store's own
defences have to be probed the way a hostile client would reach them — by
hand-assembling the JSON. The store is an enforcement point, not a convenience
layer over a cooperative SDK.

## Status

Implements [#18](../../../../issues/18). The PostgreSQL backend is Milestone 2
([ADR-0006](../../docs/adr/0006-event-store-backend.md)), and needs two things
the interface alone does not give it: a `UNIQUE (run_id, actor_did,
participant_sequence)` constraint, because application logic loses races, and a
connection role without `UPDATE` or `DELETE` grants, so immutability is
structural rather than conventional.
