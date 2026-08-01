# ADR-0004: RFC 8785 JCS + SHA-256 for canonical bytes and hashes

**Status:** Accepted
**Date:** 2026-02-19
**Spec references:** [§33.1](../specification.md#331-canonical-event), [§33.4](../specification.md#334-event-ordering), [§33.5](../specification.md#335-hash-chain), [§33.6](../specification.md#336-event-schemas), [§35.4](../specification.md#354-artifact-storage), [§51.1](../specification.md#511-epic-protocol)

## Context

[§51.1](../specification.md#511-epic-protocol) lists "define canonical
serialization" as the first task of the first epic, and it is first for a reason.
Three separate requirements depend on two different byte strings meaning the same
thing:

- **Hash chaining** ([§33.5](../specification.md#335-hash-chain)) — every event
  carries the previous event's hash, so mutation anywhere invalidates everything
  after it.
- **Signature verification** ([§6.4](../specification.md#64-attribution-invariant))
  — a verifier must reconstruct exactly the bytes the signer signed, having
  received them through JSON parse and re-serialize.
- **Artifact addressing** ([§35.4](../specification.md#354-artifact-storage)) —
  content is stored and referenced by hash.

The failure mode is specific and nasty: an implementation that serializes
`{"a":1,"b":2}` where another produces `{"b":2,"a":1}` will produce valid-looking
events that fail verification on a different implementation. Since the platform's
premise is that independent operators write their own agents in their own
languages ([§59.14](../specification.md#59-final-design-principles)), this must be
specified precisely enough for someone to implement from the text.

## Decision

### Canonical form: RFC 8785 (JSON Canonicalization Scheme)

[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) defines canonical JSON:
UTF-8, object keys sorted by UTF-16 code unit, minimal string escaping, and
ECMAScript number serialization. Output is a byte string, not a JSON string.

Constraints on top of JCS, which conforming payloads **MUST** satisfy:

1. **No floating-point numbers.** All numbers are integers in the IEEE-754
   double-safe range (±2^53−1). JCS number serialization is well defined for
   doubles but not intuitive across languages; forbidding non-integers removes an
   entire class of cross-implementation defect. Non-integer quantities are encoded
   as strings with a documented unit — `costUsd` is a decimal string, not a float.
2. **No `undefined`, no `NaN`, no `±Infinity`.** Serialization fails loudly.
3. **Absent, not null.** An optional field that has no value is omitted. Emitting
   `null` for it changes the canonical bytes and therefore the hash.
4. **No duplicate keys.** Rejected at parse time, not silently last-wins.
5. **NFC-normalized strings.** Unicode strings are Normalization Form C before
   canonicalization. JCS does not require this; without it, visually identical
   DIDs or channel names can hash differently.
6. **Depth and size limits.** Nesting depth ≤ 64, canonical bytes ≤ 1 MiB per
   event. Larger content is an artifact reference
   ([§35.4](../specification.md#354-artifact-storage)).

### Hash: SHA-256, lowercase hex, `sha256:` prefixed

```text
sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```

The prefix is an agility affordance: it costs nine bytes and makes a future
migration a validation change rather than a format change.

### What gets hashed and what gets signed

Given an event, define two derived byte strings:

```text
hashingInput  = JCS(event minus "eventHash" minus "signature")
eventHash     = "sha256:" + hex(SHA-256(hashingInput))

signingInput  = "FREEQ-FOUNDRY-V1-EVENT\n" + JCS(event minus "signature")
signature     = Ed25519-sign(privateKey, UTF8(signingInput))
```

The event hash covers everything except itself and the signature. The signature
covers the event hash, and therefore transitively covers `previousEventHash` and
the entire chain behind it. Signing input carries a domain-separation prefix
([ADR-0005](0005-signature-suite.md)).

The genesis event of a run uses
`previousEventHash = "sha256:" + "0" * 64`.

### Schemas

Every event type has a versioned JSON Schema (2020-12) as required by
[§33.6](../specification.md#336-event-schemas). Schemas are published artifacts, not
implementation details, and are hashed and included in the run's export bundle
([§33.9](../specification.md#339-event-export)).

### Conformance vectors

`packages/protocol` ships test vectors — input value, expected canonical bytes,
expected hash — as data files. An implementation in any language passes or fails
against the same file. This is the operational definition of protocol conformance.

## Options considered

### RFC 8785 JCS + SHA-256 (chosen)

A published standard with existing implementations in many languages, so external
operators are not forced to write a canonicalizer. Keeps JSON-native tooling,
JSON Schema validation, and human-readable event dumps.

### DAG-CBOR + SHA-256 multihash (IPLD)

Genuinely better on the merits: canonical by construction, no number ambiguity,
compact, and content addressing is native. Rejected because it makes every event
opaque without tooling. For a system whose primary artifact is a *human-readable,
inspectable institutional history*
([§59.17](../specification.md#59-final-design-principles), "prefer a legible
failure to an opaque success"), the debuggability of JSON is worth real bytes.
The `sha256:` prefix and the schema layer keep a migration path open.

### Protocol Buffers

Rejected. Canonical serialization is famously *not* guaranteed across protobuf
implementations — field ordering and default handling vary — which is
disqualifying for a hash chain.

### Hand-rolled canonical JSON

Rejected. This is exactly the kind of thing that looks finished and is not:
Unicode escaping, lone surrogates, and number formatting each hide corner cases.
Using a specified standard means external implementers can reach for an existing
library.

### Sign the raw received bytes rather than a canonical form

A legitimate alternative — it sidesteps canonicalization entirely by treating the
signed payload as an opaque blob and requiring the exact bytes be retained.
Rejected because events are stored in JSONB
([§35.2](../specification.md#352-event-storage)), queried, projected, and
re-exported. Retaining original bytes alongside parsed form doubles storage and
creates a second source of truth about what an event says.

## Consequences

### Positive

- Cross-language verification is achievable with off-the-shelf libraries.
- Events remain human-readable, which matters for the observer UI
  ([§38](../specification.md#38-observer-user-interface)) and for reports whose
  interpretations must link to source events
  ([§59.16](../specification.md#59-final-design-principles)).
- Test vectors give external implementers an unambiguous conformance target.

### Negative

- JSON is verbose. At Phase 7 scale this is real storage cost.
- The no-floats rule is a real constraint on payload design and will surprise
  contributors at least once. It is enforced by the serializer rather than by
  documentation.
- NFC normalization is an addition to JCS, so a stock JCS library is necessary but
  not sufficient. Conformance vectors cover it explicitly.

### Risks accepted

- SHA-256 is not post-quantum. Irrelevant for run-scale integrity, and the
  `sha256:` prefix makes migration tractable.

## Revisit when

- Event volume makes JSON storage the dominant cost. Compression at rest is the
  first response; changing the canonical form is a last resort, because it breaks
  every published conformance vector.
- A payload genuinely requires non-integer numerics and the string encoding proves
  unworkable in practice.
