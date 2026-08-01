# ADR-0008: Participants attest content; the recorder attests position

**Status:** Accepted
**Date:** 2026-02-19
**Spec references:** [§33.1](../specification.md#331-canonical-event), [§33.4](../specification.md#334-event-ordering), [§33.5](../specification.md#335-hash-chain), [§56.1](../specification.md#561-signed-action-request), [§11.5](../specification.md#115-creation-provenance-instruction-provenance-and-operational-control), [§32.3](../specification.md#323-trust-boundaries)

**Extends:** [ADR-0004](0004-canonical-serialization.md), [ADR-0005](0005-signature-suite.md), [ADR-0006](0006-event-store-backend.md)

## Context

Implementing the event store exposed a contradiction between two decisions made
here earlier, both of which are individually correct:

- [ADR-0006](0006-event-store-backend.md): `append` assigns `logicalTime`;
  clients never do, because canonical append order *is* logical time. A client
  that could set it could reorder history.
- [ADR-0004](0004-canonical-serialization.md): `eventHash` covers `logicalTime`
  and `previousEventHash`, and the signature covers `eventHash`.

Together these say a participant must sign a value it cannot know. The
contradiction is not cosmetic — it is a question about who is asserting what,
and the answer determines what the published dataset actually proves.

The specification resolves it, in a sentence that is easy to read past.
[§33.5](../specification.md#335-hash-chain) states that the hash chain "does not
itself create distributed consensus; the controller remains the canonical run
recorder." And [§56.1](../specification.md#561-signed-action-request) defines a
`SignedActionRequest` that carries `participantSequence` but pointedly has **no**
`logicalTime`. The specification already distinguishes what a participant says
from where the platform puts it.

Two claims are being made about every event, by two different parties:

1. **"I said this."** Made by the participant. Must be verifiable by anyone,
   without trusting the platform — otherwise the platform could fabricate
   attributable actions, and the attribution invariant
   ([§6.4](../specification.md#64-attribution-invariant)) is theatre.
2. **"This is where it happened."** Made by the recorder. Only the recorder can
   make it, because only the recorder observes canonical order.

Collapsing these into one signature loses one of them.

## Decision

Every canonical event carries **two** signatures.

```text
contentView  = event minus { logicalTime, previousEventHash, eventHash,
                             signature, recorderSignature }
signature    = Ed25519_participant(
                 "FREEQ-FOUNDRY-V1-EVENT\n" + JCS(contentView))

hashingInput = event minus { eventHash, recorderSignature }
eventHash    = "sha256:" + hex(SHA-256(hashingInput))

recordView   = event minus { recorderSignature }
recorderSignature
             = Ed25519_recorder(
                 "FREEQ-FOUNDRY-V1-RECORD\n" + JCS(recordView))
```

Reading the layers outward:

- The participant signs **content only**. The signature is stable regardless of
  where the event lands, so a participant can sign before knowing its position —
  which removes the need for a reservation round-trip on every submission.
- `eventHash` covers the content, the participant's signature, and the position.
- The recorder signs `eventHash`, and therefore transitively the whole chain
  behind it.

### Consequences for verification

`verifyEvent` requires the recorder DID. It cannot be inferred from the event,
because an event that named its own recorder would let a forger name themselves.
The recorder DID comes from the run manifest
([§53](../specification.md#53-example-run-manifest)) — one recorder per run,
published before the run starts.

A verifier can therefore answer three questions independently:

| Question | Checked against |
| --- | --- |
| Did this participant say this? | `signature`, participant DID |
| Has the record been altered? | `eventHash`, recomputed |
| Did the recorder place it here? | `recorderSignature`, recorder DID |

The first does not depend on trusting the recorder. That is the point.

### A new signing context

`FREEQ-FOUNDRY-V1-RECORD\n` is added to the set in
[ADR-0005](0005-signature-suite.md). A recorder signature can never be replayed
as a participant signature, and vice versa, even though a controller-operated
participant may hold both roles.

### What this does not change

Signer and actor may still differ ([§11.5](../specification.md#115-creation-provenance-instruction-provenance-and-operational-control)),
and `provenance.signerDid` remains authoritative for who signed content.
`SignedActionRequest` ([§56.1](../specification.md#561-signed-action-request))
remains the submission format for participants that do not construct events
directly; the gateway turns one into the other.

## Options considered

### Dual signature: participant attests content, recorder attests position (chosen)

Preserves both claims independently. Costs one field beyond the
[§33.1](../specification.md#331-canonical-event) shape and one extra
verification.

### Gateway reserves `logicalTime`, participant signs the positioned event

The participant asks for a position, receives one, then signs. Keeps a single
signature and matches §33.1 exactly.

Rejected. It adds a network round-trip to every action, creates a new failure
mode in abandoned reservations, and forces submissions to serialize against the
reservation rather than the append. Worse, it does not actually deliver
recorder accountability: nothing then attests that the recorder honoured the
reservation it issued.

### Single participant signature over content only; no recorder signature

Minimal, and matches §33.1 exactly. The hash chain alone would attest ordering.

Rejected, and this is the important rejection. Nothing would bind a
participant's statement to its position, so a recorder could silently reorder
history: participant signatures would still verify and the chain could be
recomputed wholesale. For an artifact whose entire value is *causal* history,
undetectable reordering is close to a total loss. §33.5 permits trusting the
controller as recorder; it does not require making that trust unfalsifiable.

### Recorder signature only

Simplest of all. Rejected: attribution would rest entirely on the platform's
word, and a compromised or dishonest platform could manufacture actions
attributable to any participant. This directly contradicts
[§32.3](../specification.md#323-trust-boundaries), which places each participant
outside the platform's trust boundary.

### Sign a Merkle root periodically instead of every event

Cheaper — one signature per checkpoint rather than per event. Worth revisiting
at scale. Rejected for now because it makes single-event verification require
an inclusion proof plus the checkpoint, which complicates the export bundle and
the observer's action trace for a saving that is speculative before we have
throughput data.

## Consequences

### Positive

- Attribution survives a dishonest platform; ordering survives a dishonest
  participant. Neither party can forge the other's claim.
- Participants sign without a round-trip, so submission stays one-shot.
- The three verification questions are separable, which makes a failed
  verification diagnosable rather than merely red.

### Negative

- One field beyond the literal §33.1 shape. Recorded here as a deliberate
  extension rather than a drift.
- Two Ed25519 verifications per event instead of one. Ed25519 verification is
  ~50µs; at Phase 7 volumes this is worth re-measuring, not worth pre-optimising.
- Verifiers must obtain the recorder DID out of band. This is a feature — it
  forces the run manifest to be part of the published dataset — but it is one
  more thing an external implementer must get right, so it belongs in the
  conformance vectors.

### Risks accepted

- A compromised recorder key allows silent reordering of events whose content
  signatures remain valid. Mitigated by the chain making *retroactive* edits
  evident, and by the recorder key being controller-held
  ([§32.3](../specification.md#323-trust-boundaries)). Full protection requires
  external anchoring, which §33.5 explicitly declines.

## Revisit when

- Throughput data justifies checkpoint-based recorder attestation instead of
  per-event.
- [§58.15](../specification.md#5815-organizational-personhood) gives the
  organization its own keys, which raises the question of whether an
  organization can act as recorder for its own history. It should not.
