# Architecture Decision Records

An ADR captures a single architecturally significant decision: the context that
forced it, the option chosen, the options rejected, and the consequences accepted.

ADRs are immutable once accepted. To change a decision, write a new ADR that
supersedes the old one and update both records' status lines. Never rewrite
history — the same principle the platform itself enforces
([§6.8 Historical integrity](../specification.md#68-historical-integrity-invariant)).

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-typescript-monorepo.md) | TypeScript modular monolith in a pnpm workspace | Accepted |
| [0003](0003-did-methods.md) | `did:key` first, `did:web` second, behind a resolver interface | Accepted |
| [0004](0004-canonical-serialization.md) | RFC 8785 JCS + SHA-256 for canonical bytes and hashes | Accepted |
| [0005](0005-signature-suite.md) | Ed25519 with domain-separated signing payloads | Accepted |
| [0006](0006-event-store-backend.md) | Event store interface with in-memory and PostgreSQL backends | Accepted |
| [0007](0007-defer-policy-language.md) | Defer the policy language decision to Milestone 4 | Superseded by ADR-0010 |
| [0008](0008-event-authorship.md) | Participants attest content; the recorder attests position | Accepted |
| [0009](0009-research-protocol-harness-requirements.md) | Harness requirements implied by the research protocol | Accepted |
| [0010](0010-policy-language.md) | A restricted conjunctive policy language | Accepted |

## Status values

- **Proposed** — under discussion, not binding
- **Accepted** — binding; implementations must conform
- **Superseded by ADR-NNNN** — no longer binding, retained for history
- **Deferred** — deliberately not deciding yet, with a named trigger for deciding

## Relationship to the specification

The [specification](../specification.md) is normative about *what* the system must
do. ADRs are normative about *how* this implementation does it. Where the
specification leaves a choice open — most explicitly in
[§58 Open Questions](../specification.md#58-open-questions) — an ADR closes it.

See [open-questions.md](../open-questions.md) for the current disposition of all
fifteen §58 questions.

## Template

```markdown
# ADR-NNNN: Title

**Status:** Proposed | Accepted | Superseded by ADR-NNNN | Deferred
**Date:** YYYY-MM-DD
**Spec references:** §N.N, §N.N
**Supersedes:** — 
**Superseded by:** —

## Context

What forces are at play? What makes this decision necessary now? What would go
wrong if we deferred it?

## Decision

What we are doing, stated so an implementer can conform without reading further.

## Options considered

### Option A (chosen)
### Option B (rejected)
Why it lost.

## Consequences

### Positive
### Negative
### Risks accepted

## Revisit when

The concrete trigger that should reopen this decision.
```
