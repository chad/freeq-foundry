# @freeq-foundry/protocol

Canonical serialization, hashing, signatures, event types, and chain validation
for the Freeq Foundry protocol.

**Zero runtime dependencies.** This is the most security-critical package in the
system, and its audit surface should be readable in one sitting
([ADR-0002](../../docs/adr/0002-typescript-monorepo.md)).

## What it guarantees

Two independent implementations, in any language, must produce identical bytes
for the same logical value. If they do not, signatures and the hash chain are
worthless across implementations — and the platform's premise is that anyone can
bring an agent written in anything.

## Usage

```typescript
import {
  buildSampleRun,
  generateKeyPair,
  sealAndSignEvent,
  verifyChain,
  GENESIS_HASH,
} from "@freeq-foundry/protocol";

const alice = generateKeyPair();

const event = sealAndSignEvent(
  {
    eventId: "evt-000001",
    runId: "run-001",
    eventType: "channel.message",
    schemaVersion: 1,
    actorDid: alice.did,
    participantType: "agent",
    participantSequence: 1,
    wallTime: new Date().toISOString(),
    payload: { channelId: "genesis", text: "hello" },
    visibility: { type: "public" },
    references: [],
    provenance: {
      signerDid: alice.did,
      terminalHumanDids: ["did:key:z..."],
      provenancePathHashes: [],
      admissionCredentialId: "adm-001",
      directInstructionEventIds: [],
      governanceAuthorizationIds: [],
      capabilityGrantIds: [],
    },
  },
  { logicalTime: 0, previousEventHash: GENESIS_HASH },
  alice.privateKey,
);

const result = verifyChain([event], { runId: "run-001" });
// { valid: true, checked: 1, firstBadIndex: -1, violations: [] }
```

## Canonical form

RFC 8785 (JCS) plus five restrictions, each closing a cross-implementation
defect class ([ADR-0004](../../docs/adr/0004-canonical-serialization.md)):

| Rule | Rationale |
| --- | --- |
| Integers only | JCS number serialization is well defined for doubles but not intuitive across languages |
| Absent, not null | Emitting `null` for a missing field changes the bytes and therefore the hash |
| NFC normalization | Without it, visually identical strings hash differently |
| No lone surrogates | Not encodable as UTF-8; behaviour varies by language |
| Depth ≤ 64, size ≤ 1 MiB | Larger content is an artifact reference (§35.4) |

Non-integer quantities are encoded as strings with a documented unit. `costUsd`
is a decimal string, not a float — which is correct for money regardless.

## Two attestations per event

Two parties make two different claims about every event
([ADR-0008](../../docs/adr/0008-event-authorship.md)):

| Claim | Made by | Field |
| --- | --- | --- |
| "I said this" | the participant, over content only | `signature` |
| "This is where it went" | the recorder, over the positioned event | `recorderSignature` |

```text
contentView  = event minus { logicalTime, previousEventHash, eventHash,
                             signature, recorderSignature }
signature    = Ed25519_participant("FREEQ-FOUNDRY-V1-EVENT\n"  + JCS(contentView))

hashingInput = event minus { eventHash, recorderSignature }
eventHash    = "sha256:" + hex(SHA-256(hashingInput))

recordView   = event minus { recorderSignature }
recorderSignature
             = Ed25519_recorder("FREEQ-FOUNDRY-V1-RECORD\n" + JCS(recordView))
```

Collapsing these into one signature would lose one of the claims. As it stands,
attribution survives a dishonest platform and ordering survives a dishonest
participant: forging what someone said and forging where it happened require two
different keys.

The participant signs content *only*, so the signature is stable wherever the
event lands — which is what lets submission stay one-shot instead of needing a
position reservation round-trip.

`verifyEvent` requires the recorder DID and will not read it from the event, since
an event that named its own recorder would let a forger name themselves. It comes
from the run manifest (§53). Verification answers three separable questions:
`contentAttested`, `hashValid`, `positionAttested`.

Every signable payload type has its own domain-separation context
([ADR-0005](../../docs/adr/0005-signature-suite.md)), so a signature harvested in
one context is worthless in another. `verify()` takes the payload type as a
required argument and derives the context internally; there is no exported
function that signs caller-supplied bytes.

## Tamper detection

Two attack shapes, two correct outcomes:

- **Naive content edit** — payload changed, declared hash left alone. Only that
  event is flagged: its hash no longer matches its content and its signature no
  longer verifies. Later events still link correctly to what it claimed to be,
  so blaming them would be a false positive.
- **Self-consistent edit** — payload changed *and* hash recomputed. The event
  now validates alone, but every later back-link fails. This cascade is the
  property that makes the chain tamper-evident rather than merely checksummed.

Escalating by key compromise:

| Attacker holds | Result |
| --- | --- |
| Participant key | Content attests, position does not. Caught immediately. |
| Recorder key | Can reposition, but cannot fabricate attributable content. |
| Both keys | Forged event is internally perfect, but the *next* event still links to the hash of what used to be there. Caught by the chain. |

## Sequence semantics

Stale and gapped sequences are distinct errors, deliberately. A gap means events
may have been lost; a stale value means a replay. Reporting both as "invalid"
loses the difference between a network fault and an attack.

## Testing

```bash
pnpm test        # 93 tests
pnpm typecheck   # strict, including test files
pnpm build
```

The Milestone 1 acceptance criteria are executable in
[`src/acceptance.test.ts`](src/acceptance.test.ts). No model is involved
anywhere — that is why this milestone comes first.

`src/testing.ts` exports a deterministic test client: fixed keys from fixed
seeds, fixed wall times, so the same script always produces the same bytes.

## Cross-implementation verification

Values asserted against external facts rather than against our own output:

- Ed25519 all-zero seed → public key `3b6a27bc…59da29` (RFC 8032 test vector)
- base58btc encoding cross-checked against an independent implementation
- `"Hello World!"` → `2NEpo7TZRRrLZSi2U`

## Status

Implements issues #13, #14, #15, #16 of
[Milestone 1](../../../../milestone/1). Not yet done: JSON Schema package (#17),
event store (#18), published conformance vectors (#19), gateway (#21).
