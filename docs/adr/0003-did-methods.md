# ADR-0003: `did:key` first, `did:web` second, behind a resolver interface

**Status:** Accepted
**Date:** 2026-02-19
**Spec references:** [§11.1](../specification.md#111-identity-requirement), [§51.2](../specification.md#512-epic-provenance), [§58.1](../specification.md#581-did-method), [§6.3](../specification.md#63-key-possession-invariant)

**Closes open question:** [§58.1 DID method](../specification.md#581-did-method)

## Context

[§11.1](../specification.md#111-identity-requirement) requires every participant
identity to be a DID resolvable under a Freeq-supported method, with a document
exposing verification methods, signing keys, service endpoints, supported protocol
interfaces, and optional agent metadata.

[§58.1](../specification.md#581-did-method) leaves the choice open, saying only
that the implementation should use an abstraction and begin with methods Freeq
already supports.

The choice is load-bearing in an unobvious way. DID resolution is on the critical
path of every provenance verification
([§11.4](../specification.md#114-provenance-proof)), and provenance verification
is on the critical path of every consequential action
([§6.4](../specification.md#64-attribution-invariant)). A method with network
resolution introduces latency, an availability dependency, and a mutability
problem: if a DID document can change, then "was this key valid at issuance?"
([§11.4](../specification.md#114-provenance-proof), condition 4) requires
historical resolution, not current resolution.

## Decision

Support DID methods behind a `DidResolver` interface. Ship `did:key` first,
`did:web` second.

### The resolver interface

```typescript
interface DidResolver {
  readonly method: string;
  canResolve(did: string): boolean;
  resolve(did: string, at?: ResolutionTime): Promise<DidResolution>;
}
```

Resolution accepts an optional point in time. Implementations that cannot answer
historical questions must say so explicitly rather than silently returning
current state — a resolver that answers a historical question with present data
is worse than one that refuses.

### `did:key` first

`did:key` ([W3C](https://w3c-ccg.github.io/did-method-key/)) encodes the public
key in the identifier itself. Resolution is a pure function: no network, no
storage, no availability dependency, and no mutability problem. The key valid at
issuance is the key in the identifier, permanently.

This makes it the correct choice for Milestone 1, whose acceptance criteria are
about protocol correctness and replay determinism, not key lifecycle.

Restricted to Ed25519 (multicodec `0xed01`, base58btc, `z` prefix) per
[ADR-0005](0005-signature-suite.md).

### `did:web` second

`did:web` is required before any public run because operators need identifiers
they control and can rotate. It arrives with Milestone 2 and brings three
obligations:

1. **Resolution results are cached and recorded as artifacts.** The resolved
   document at verification time is content-addressed and referenced from the
   event, so replay does not depend on a third-party server still existing or
   still serving the same bytes. This is the [§6.9 replay
   invariant](../specification.md#69-replay-invariant) applied to identity.
2. **Rotation is expressed through credentials, not document mutation.** A
   changed `did:web` document does not retroactively invalidate signatures made
   with a previously valid key; revocation is an explicit signed event
   ([§56.5](../specification.md#565-credential-revocation)).
3. **Fetches are treated as untrusted network I/O** — timeouts, size limits, no
   redirects off-origin, no SSRF into private ranges
   ([§6.10](../specification.md#610-safety-invariant)).

### Key possession

Neither method by itself satisfies [§6.3](../specification.md#63-key-possession-invariant).
Possession is proved by a challenge–response at admission
([§13.5](../specification.md#135-conversational-interaction)) and re-proved
implicitly by every signed action. Resolution establishes *which key*; signatures
establish *who holds it*.

## Options considered

### `did:key` then `did:web`, behind an interface (chosen)

Fastest path to a testable Milestone 1, with a credible path to operator-controlled
identity. The interface means the ordering is a scheduling decision, not an
architectural one.

### `did:web` only

Rejected for Milestone 1. Every protocol test would need an HTTP fixture, making
the conformance suite slower, flakier, and harder for external implementers to
run. Conformance tests must be executable offline.

### `did:pkh` / blockchain-anchored methods

Rejected. They import a consensus dependency the platform explicitly does not
want — [§33.5](../specification.md#335-hash-chain) is clear that the hash chain
"does not itself create distributed consensus; the controller remains the
canonical run recorder."

### A bespoke `did:freeq` method

Rejected for now, with reservations. It would give exact control over rotation
and historical resolution, and [§58.15](../specification.md#5815-organizational-personhood)
raises the possibility that the *organization itself* receives a DID — which a
bespoke method would serve well. But defining a DID method is a substantial
undertaking that Milestone 1 does not need, and the resolver interface keeps the
option open.

### Accept any DID method via a universal resolver

Rejected. It maximises interoperability and minimises control, which is the wrong
trade for a system whose central claim is verifiable attribution. Every supported
method must have known resolution and rotation semantics.

## Consequences

### Positive

- Milestone 1 has no network dependency in its verification path.
- Conformance tests run offline, so external implementers can self-certify.
- Adding methods is additive.

### Negative

- `did:key` identifiers are long, opaque, and unrotatable. Rotation means a new
  DID plus a credential linking old to new, which the lineage graph must render
  sensibly.
- Two methods means two sets of rotation and revocation semantics to document.

### Risks accepted

- `did:key`'s unrotatability means a compromised prototype key is only remediable
  by revoking the identity and re-admitting a successor. Acceptable before public
  runs; `did:web` must land before them.

## Revisit when

- Freeq core designates a canonical DID method — that decision supersedes this one.
- [§58.15](../specification.md#5815-organizational-personhood) is answered
  affirmatively and the organization needs constitutionally controlled keys, which
  likely requires a method supporting threshold or multi-key control.
