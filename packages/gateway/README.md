# @freeq-foundry/gateway

The only writer ([§32.2](../../docs/specification.md#322-high-level-flow)). Every
[§33.4](../../docs/specification.md#334-event-ordering) rejection is enforced
before an event reaches the store.

## What it adds over the store

The store checks cryptography and ordering. The gateway checks three things the
store has no notion of:

1. **Admission** — whether this participant may act at all
   ([§6.1](../../docs/specification.md#61-participation-invariant)).
2. **Visibility filtering** — subscribers see only what their role permits
   ([§33.7](../../docs/specification.md#337-visibility)). A store read is
   unfiltered by design.
3. **Idempotent acknowledgement** — a retry after a lost acknowledgement is a
   normal occurrence, not an error
   ([§36.9](../../docs/specification.md#369-api-idempotency)).

## Submission

```typescript
const result = await gateway.submit(attestedEvent);

if (result.accepted) {
  result.logicalTime; // position the recorder assigned
  result.eventHash;
  result.duplicate;   // true if this was an idempotent retry
} else {
  result.code;        // stable, machine-readable
  result.path;        // field at fault
  result.remediation; // what to do about it
}
```

Rejections carry remediation because a diagnostic that says only "invalid" makes
an operator guess. From
[§13.6](../../docs/specification.md#136-diagnostic-modes): a broken configuration
should receive precise guidance.

### Check order

Cheapest first, and **admission before cryptography**. A stranger with a bad
signature should be told they are not admitted — telling them their signature is
invalid sends them debugging the wrong thing.

1. Shape: IDs present, signature present, sequence positive
2. Position fields absent (see below)
3. Clock skew
4. Admission: known, not suspended, type matches, credential matches
5. Store: signature, sequence, size, canonicalizability, chain

## Submissions may not carry position

`logicalTime`, `previousEventHash`, `eventHash`, and `recorderSignature` are
rejected outright. A client that could set position could place itself in history
([ADR-0008](../../docs/adr/0008-event-authorship.md)).

The schema already forbids them; the gateway refuses them explicitly so the error
says what is actually wrong rather than "unknown field".

## Clock skew

`wallTime` is participant-reported and **inside the signature**, so the gateway
cannot correct it — only refuse it. Default tolerance is five minutes.

This is not fastidiousness: the research protocol's primary outcome is measured on
elapsed run time ([ADR-0009](../../docs/adr/0009-research-protocol-harness-requirements.md)),
and unbounded skew would let a participant distort it.

## Subscription

```typescript
for await (const event of gateway.subscribe(runId, viewer)) { ... }
```

Filtering happens here rather than in the store because visibility is a question
about *the asker*, and the store has no notion of one.

| Policy | Visible to |
| --- | --- |
| `public` | everyone |
| `channel` | members of that channel |
| `participants` | the named DIDs |
| `lineage` | viewers sharing that terminal human root |
| `controller` | the controller only |
| `post_run_reveal` | everyone, once the run has ended |

Two rules cut across all of them:

- **The controller sees everything.** It already holds the recorder key;
  withholding would be theatre.
- **A participant always sees its own events**, whatever the policy. Otherwise an
  agent could not audit its own history.

`canSee` is **default-deny**: an unrecognized policy hides the event. Failing open
would leak controller-only material the first time a new policy type shipped.

## Admission is an interface

```typescript
interface AdmissionRegistry {
  lookup(runId: string, did: string): Promise<Admission | undefined> | Admission | undefined;
}
```

`StaticAdmissionRegistry` is sufficient for Milestone 1 and for tests. Milestone 2
replaces it with credential-chain verification
([§11.4](../../docs/specification.md#114-provenance-proof)) without the gateway
changing.

## Testing

```bash
pnpm test  # 35 tests
```

Notably tested: that a maximally privileged participant — channel member, matching
lineage, post-run — still cannot see controller-only events.

## Status

Implements [#21](../../../../issues/21). Not yet built, and deliberately out of
Milestone 1: the HTTP/WebSocket transport, rate limiting
([§14.7](../../docs/specification.md#147-communication-rate-limits)), and
`SignedActionRequest` intake
([§56.1](../../docs/specification.md#561-signed-action-request)) for participants
that do not construct events directly. The gateway is currently an in-process API,
which is all the milestone's model-free acceptance criteria require.
