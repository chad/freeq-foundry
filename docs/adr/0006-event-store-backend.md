# ADR-0006: Event store interface with in-memory and PostgreSQL backends

**Status:** Accepted
**Date:** 2026-02-19
**Spec references:** [§32.5](../specification.md#325-technology-recommendations), [§33.4](../specification.md#334-event-ordering), [§34.1](../specification.md#341-principle), [§35.2](../specification.md#352-event-storage), [§35.3](../specification.md#353-immutable-writes), [§50](../specification.md#50-implementation-roadmap)

## Context

Milestone 1's acceptance criteria are that "deterministic test clients produce a
valid replay", "mutation is detected", and "duplicate events are rejected"
([§50](../specification.md#50-implementation-roadmap)). None of those require a
database. All of them require an append-only log with well-defined ordering and
rejection semantics.

[§32.5](../specification.md#325-technology-recommendations) recommends PostgreSQL
and [§35.2](../specification.md#352-event-storage) gives a concrete schema, so the
production answer is settled. The open question is whether Milestone 1 should
require it.

There is also a correctness question that outranks the convenience one.
[§35.3](../specification.md#353-immutable-writes) states that application roles
**MUST NOT** update or delete canonical events. An ORM with a permissive
connection role satisfies this by convention. A database role without `UPDATE` or
`DELETE` grants satisfies it structurally. The specification's whole posture — no
ambient authority, enforcement over assertion — argues for the latter.

## Decision

Define `EventStore` in `packages/event-store` as an interface, with two backends.

### The interface

```typescript
interface EventStore {
  append(event: SignedEvent): Promise<AppendResult>;
  appendBatch(events: SignedEvent[]): Promise<AppendResult[]>;
  read(runId: string, options?: ReadOptions): AsyncIterable<SignedEvent>;
  head(runId: string): Promise<ChainHead | undefined>;
  sequenceFor(runId: string, actorDid: string): Promise<number>;
  verifyChain(runId: string, options?: VerifyOptions): Promise<ChainVerification>;
}
```

There is no `update`. There is no `delete`. Corrections happen through new events
([§35.3](../specification.md#353-immutable-writes)); an interface that cannot
express mutation cannot accidentally permit it.

`append` is the sole enforcement point for
[§33.4](../specification.md#334-event-ordering) rejections: invalid signature,
duplicate event ID, stale or gapped participant sequence, unknown run, invalid
admission, malformed payload, oversized event, broken hash chain. It assigns
`logicalTime` — clients never do, because canonical append order *is* logical time.

### In-memory backend (Milestone 1)

Full semantics, no persistence. It is the reference implementation and the
conformance-test target. If a rejection rule is not enforced here, it does not
exist.

### PostgreSQL backend (Milestone 2)

Schema per [§35.2](../specification.md#352-event-storage), with additions:

1. **`UNIQUE (run_id, logical_time)`** as specified, plus `UNIQUE (run_id,
   actor_did, participant_sequence)`. Sequence enforcement belongs in the database
   constraint, not only in application logic — application logic loses races.
2. **A revoked-write role.** The application connects as a role with `INSERT` and
   `SELECT` on `events` and no `UPDATE` or `DELETE`. Migrations use a separate
   role. This makes [§35.3](../specification.md#353-immutable-writes) structural.
3. **`logical_time` assigned inside the append transaction**, serialized per run.
4. **`references` is a reserved word in SQL** and must be quoted or renamed. The
   column is named `event_references`; the JSON field remains `references` as the
   specification requires. Recorded here because it is exactly the kind of silent
   divergence that costs an afternoon.
5. **`payload`, `visibility`, `provenance` as `JSONB`;** original canonical bytes
   are not stored, since they are reproducible by
   [ADR-0004](0004-canonical-serialization.md). Chain verification recomputes them
   — which means every verification also tests the canonicalizer.

### Both backends pass the same suite

One conformance suite runs against both. A backend that diverges is broken by
definition, and the in-memory implementation is what the suite is written against.

## Options considered

### Interface with two backends (chosen)

Milestone 1 ships and tests without infrastructure; production gets durability
and constraint enforcement; the interface keeps replay and projection code
backend-agnostic.

### PostgreSQL only, from the start

Rejected for Milestone 1. Every protocol test would need a live database,
slowing the loop and making external conformance checking harder. Deferred, not
avoided — Milestone 2 needs it.

### In-memory or file-based only

Rejected as an endpoint. Loses durability, concurrent access, the constraint
enforcement described above, and the JSONB query capability that projections and
the observer API need.

### An event-sourcing framework (EventStoreDB, Marten, etc.)

Rejected. The requirements here are unusual — cryptographic chaining, signature
verification on append, per-participant sequence enforcement, and a visibility
model with five levels ([§33.7](../specification.md#337-visibility)) — and would
mostly be fought rather than served by a general framework. The append-only-log
part is the easy part.

### SQLite

Rejected as primary; genuinely attractive for single-run local experiments and
for the export bundle format. Worth reconsidering as a *third* backend for
offline replay of published datasets, where a single-file dataset is a feature.

## Consequences

### Positive

- Milestone 1 has no infrastructure dependency.
- Immutability is enforced by database grants, not by reviewer vigilance.
- Replay, projection, and verification code is written once.
- Running the suite against both backends catches divergence immediately.

### Negative

- Two implementations to maintain, and the in-memory one will be tempting to let
  drift. The shared suite is the guard.
- Serializing `logicalTime` assignment per run is a write bottleneck. Acceptable:
  a total order per run is a requirement, not an optimization target.

### Risks accepted

- The in-memory backend's fidelity depends entirely on the shared suite being
  thorough. A gap in the suite is a gap in both backends simultaneously.

## Revisit when

- Append throughput becomes a bottleneck at
  [Phase 7 scale](../specification.md#phase-7-large-scale-run).
- Published dataset replay needs a self-contained single-file format — evaluate
  SQLite as a third backend.
