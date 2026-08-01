# @freeq-foundry/identity

DIDs, credentials, provenance verification, revocation, and admission.

Enforces two invariants that were previously *represented* in every event and
verified nowhere:

- **[§6.2](../../docs/specification.md#62-human-root-invariant) human-root** — every
  agent has an unbroken signed chain to an accepted human DID.
- **[§6.3](../../docs/specification.md#63-key-possession-invariant) key possession** —
  every participant proves control of its private key.

Before this package, lineage was asserted by the scenario. Now it is proved by the
participant, and a scenario cannot claim a lineage it cannot demonstrate.

## The nine conditions

[§11.4](../../docs/specification.md#114-provenance-proof) lists nine conditions a
proof must satisfy. All nine are checked, each reports separately, and a proof is
valid only if every one passes.

| # | Condition |
| --: | --- |
| 1 | Subject DID matches the first child in the chain |
| 2 | Each edge connects correctly |
| 3 | Each signature verifies |
| 4 | All keys were valid at issuance |
| 5 | No required credential has expired |
| 6 | No required credential was revoked **at action time** |
| 7 | The terminal DID has an accepted human-root credential |
| 8 | The participant proves current key possession |
| 9 | Scenario depth and fan-out constraints pass |

Reporting them separately matters. "Your chain is invalid" sends an operator
guessing; "condition 6: the credential linking you to your parent was revoked at
14:03" is actionable, which is what
[§13.6](../../docs/specification.md#136-diagnostic-modes) requires.

### Conditions that are easy to get wrong

**4 is not implied by 3.** A credential signed by a key that had already been
retired verifies perfectly and must still be rejected. `did:key` cannot rotate, so
this condition is trivially satisfied today — it becomes load-bearing with
`did:web`, which is why it is checked rather than assumed.

**6 is time-relative, always.** A credential revoked at 14:03 was valid at 14:02,
and every action taken then remains authorized
([§6.8](../../docs/specification.md#68-historical-integrity-invariant)). Status is
asked *as of* an instant, never in the present tense.

**8 is not resolution.** Resolving a DID establishes *which* key; only a signature
establishes *who holds it*. Without a challenge, anyone could present a stranger's
DID and a perfectly valid public chain.

**Nothing passes vacuously.** A malformed chain fails every condition with
`not evaluated: …` rather than letting later checks pass by not running. A
condition that passed because it could not run is the most dangerous kind of green.

## Branch on codes, never on prose

`ConditionResult.detail` is prose for humans and will be reworded.
`ConditionResult.codes` carries stable identifiers. The admission service branches
on codes — it briefly did not, and a reworded message would have silently turned a
fan-out rejection into a generic one.

## Revocation and blast radius

```typescript
const radius = computeBlastRadius("hrc-1", credentials);
// → "revoking hrc-1 suspends 3 participants, including 2 descendant(s)
//    whose provenance runs through it"
```

Answered *before* revoking, because an operator revoking a root needs to know they
are about to suspend eleven agents rather than one, and finding out afterwards is
how a run gets ruined ([§11.10](../../docs/specification.md#1110-revocation)).

Unsigned revocations are refused. Anyone who could revoke without signing could
silently strip authority from a participant, which is an attack rather than an
administrative action.

## Lineage visibility

[§58.3](../../docs/specification.md#583-lineage-visibility) is a genuine
experimental variable, not a privacy setting: whether agents can *detect* that they
share a root determines whether they coordinate against sybil influence or collude
because of it.

| Level | Discloses |
| --- | --- |
| `exact` | The terminal human DID |
| `hashed` | A per-run pseudonym — enough to know *that* you share a root, not *whose* (**default**) |
| `counts_only` | Nothing |

Pseudonyms are salted with the run ID, so a root cannot be correlated across runs.
That preserves [§11.8](../../docs/specification.md#118-pseudonymity) pseudonymity
while keeping [§49.7](../../docs/specification.md#497-condition-g-one-did-one-vote)
and [§49.8](../../docs/specification.md#498-condition-h-one-human-root-one-vote)
distinguishable.

An unknown visibility level discloses **nothing**. Failing open would leak lineage
the first time a new level shipped.

## Fan-out

[§58.4](../../docs/specification.md#584-agent-count-per-human)'s recommended
answer, adopted: impose a generous platform ceiling, disclose lineage, and let
governance decide political weight. The ceiling is not amendable by governance
([§6.7](../../docs/specification.md#67-external-objective-invariant)).

This has a consequence worth noticing: with verified provenance, three agents run
by one operator are genuinely **one** lineage. The genesis quorum needs two, so
that operator cannot pass a proposal alone — demonstrated in
[`run.test.ts`](../controller/src/run.test.ts).

## Testing

```bash
pnpm test   # 61 tests
```

The Milestone 2 acceptance criteria are executable: a human creates Agent A, A
creates B, B proves the path, an invalid edge is rejected, and root revocation
suspends descendants.

## Status

Implements [#2](../../../../issues/2). Not built: `did:web`
([ADR-0003](../../docs/adr/0003-did-methods.md) — needed before any public run, and
it brings cached resolution artifacts with it), and stronger human verification
([§58.2](../../docs/open-questions.md#582--human-verification-strength) — the
prototype uses controller-issued roots, which §11.2 permits).
