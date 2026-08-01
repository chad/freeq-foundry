# ADR-0005: Ed25519 with domain-separated signing payloads

**Status:** Accepted; extended by [ADR-0008](0008-event-authorship.md)
**Date:** 2026-02-19
**Spec references:** [§6.3](../specification.md#63-key-possession-invariant), [§6.4](../specification.md#64-attribution-invariant), [§33.1](../specification.md#331-canonical-event), [§45](../specification.md#45-security-and-threat-model), [§56.1](../specification.md#561-signed-action-request)

> [ADR-0008](0008-event-authorship.md) adds a ninth context,
> `FREEQ-FOUNDRY-V1-RECORD`, for recorder attestation of event position.

## Context

Signatures appear in at least seven places in the specification: canonical events
([§33.1](../specification.md#331-canonical-event)), signed action requests
([§56.1](../specification.md#561-signed-action-request)), human-root credentials
([§11.2](../specification.md#112-human-root-credential)), agent creation
credentials ([§11.3](../specification.md#113-agent-creation-credential)), tool
execution records ([§56.3](../specification.md#563-tool-execution)), evaluator
results ([§30](../specification.md#30-external-product-evaluation)), and channel
messages ([§14.4](../specification.md#144-signed-message-event)).

Distinct payload types signed by the same key create a cross-protocol attack
surface: if a credential and an event can produce identical signing bytes, a
signature harvested from one context can be replayed in the other. This is not
theoretical — it is a recurring finding in signed-message systems, and it is
cheap to prevent at design time and expensive to retrofit.

The algorithm choice is also constrained by [ADR-0003](0003-did-methods.md):
`did:key` embeds the key type in the identifier, so the DID method and the
signature suite are the same decision viewed from two directions.

## Decision

### Algorithm: Ed25519 (PureEdDSA, RFC 8032)

One algorithm, no negotiation, for v1. Signatures are 64 bytes; public keys are
32 bytes.

`did:key` encoding uses multicodec `0xed01` with base58btc and the `z` prefix, so
a Freeq Foundry DID looks like:

```text
did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK
```

### Encoding: base64url, unpadded

Signatures in JSON are base64url without padding (RFC 4648 §5). Not base58 — it
is slower and only justified when humans transcribe the value, which they do not
for signatures. Not hex — 33% larger for no benefit.

### Domain separation

Every signable payload type has a distinct ASCII context string, prefixed to the
canonical bytes before signing:

| Payload type | Context string |
| --- | --- |
| Canonical event | `FREEQ-FOUNDRY-V1-EVENT\n` |
| Signed action request | `FREEQ-FOUNDRY-V1-ACTION\n` |
| Human-root credential | `FREEQ-FOUNDRY-V1-HUMAN-ROOT\n` |
| Agent creation credential | `FREEQ-FOUNDRY-V1-AGENT-CREATION\n` |
| Tool execution record | `FREEQ-FOUNDRY-V1-TOOL-EXEC\n` |
| Evaluation result | `FREEQ-FOUNDRY-V1-EVALUATION\n` |
| Key-possession challenge | `FREEQ-FOUNDRY-V1-CHALLENGE\n` |
| Credential revocation | `FREEQ-FOUNDRY-V1-REVOCATION\n` |

The version component means a v2 payload can never collide with a v1 payload
under the same key.

```text
signingInput = contextString + JCS(payload minus its signature field)
signature    = base64url(Ed25519-sign(privateKey, UTF8(signingInput)))
```

A verifier **MUST** reject a signature validated against the wrong context. The
API makes this structurally hard: `verify()` takes the payload type as a required
argument and derives the context internally. Callers cannot pass raw bytes.

### Replay resistance

A valid signature is necessary but never sufficient. The gateway additionally
enforces, per [§33.4](../specification.md#334-event-ordering):

- `runId` matches the active run — a signature from another run is invalid here;
- `participantSequence` is exactly one greater than the last accepted sequence
  for that `(runId, actorDid)`, so replay and omission are both detectable;
- `eventId` has not been seen — duplicates rejected;
- `issuedAt` falls within an acceptable skew window, and `expiresAt`, if present,
  has not passed.

### Key handling

Private keys never enter events, payloads, logs, or projections
([§35.5](../specification.md#355-secret-separation)). The platform holds signing
keys only for controller-operated and platform-internal identities; externally
operated agents hold their own and the platform never sees them
([§32.3](../specification.md#323-trust-boundaries)).

### Implementation

Node's built-in `node:crypto` Ed25519 support. No third-party cryptographic
dependency in `packages/protocol`
([ADR-0002](0002-typescript-monorepo.md)) — the smallest possible audit surface
for the most security-critical package.

## Options considered

### Ed25519, single suite, domain-separated (chosen)

Fast, small, deterministic, no per-signature randomness to leak a key, no curve
parameters to get wrong, and universally available including in `node:crypto`.
Determinism matters here beyond safety: it makes conformance vectors exact rather
than merely verifiable.

### ECDSA P-256

Rejected as the primary suite. Comparable security, better hardware and passkey
support — which will matter for human-root credentials
([§11.2](../specification.md#112-human-root-credential)) — but non-deterministic
signatures make byte-exact test vectors impossible, and nonce handling has a long
history of catastrophic implementation errors.

Noted: WebAuthn passkeys are a listed human-verification method and are typically
P-256. That argues for adding P-256 **for human-root credentials specifically**
at Milestone 2, not for adopting it platform-wide now.

### Algorithm agility from day one

Rejected. Negotiable algorithms mean downgrade attacks and a combinatorial
conformance matrix. Agility here is version-level: v2 of the protocol may specify
a different suite, and the context strings already encode the version.

### JWS / COSE envelopes

Rejected. Both are mature and well-tooled, and JWS in particular would be a
defensible choice. But both carry algorithm identifiers *inside* the signed
envelope, reintroducing negotiation, and JWS's `alg: none` history plus its
base64url-of-JSON layering conflicts with a canonical-bytes design where the hash
chain must cover the parsed structure, not an encoded wrapper.

### Signing the hash rather than the payload

Rejected. Ed25519 hashes internally; signing a hash adds no value and creates a
second thing to get wrong. Signing input is the domain string plus canonical
bytes, always.

## Consequences

### Positive

- One algorithm, one code path, one set of test vectors.
- Deterministic signatures make conformance testing byte-exact across languages.
- Domain separation eliminates cross-protocol signature reuse by construction.
- Zero cryptographic dependencies in the protocol package.

### Negative

- Ed25519 lacks the hardware-token and passkey ubiquity of P-256, which
  complicates strong human verification
  ([§58.2](../specification.md#582-human-verification)).
- Committing to one suite means a future migration is a protocol version bump,
  not a configuration change. This is intentional.

### Risks accepted

- Not post-quantum. Irrelevant at run timescales.
- External operators must correctly implement domain separation. Mitigated by
  shipping conformance vectors that include negative cases — a signature valid
  under the wrong context must fail.

## Revisit when

- Human-root credentials need passkey binding
  ([§11.2](../specification.md#112-human-root-credential),
  [§58.2](../specification.md#582-human-verification)). Expect to add P-256 as a
  second suite scoped to credentials, not to events.
- [§58.15](../specification.md#5815-organizational-personhood) requires threshold
  or multi-signature organizational keys, which Ed25519 alone does not provide.
  Note that [§20.6](../specification.md#206-multi-signature-actions) multi-party
  approval is satisfied today by *multiple independent signatures*, not by
  threshold cryptography — a deliberate simplification.
