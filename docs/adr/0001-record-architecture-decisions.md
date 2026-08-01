# ADR-0001: Record architecture decisions

**Status:** Accepted
**Date:** 2026-02-19
**Spec references:** [§6.8](../specification.md#68-historical-integrity-invariant), [§58](../specification.md#58-open-questions)

## Context

Freeq Foundry is a research platform. Its output is a claim about how autonomous
institutions form, and the credibility of that claim depends on readers being able
to distinguish results from artifacts of implementation choices. If a run produces
surprising governance behaviour, a reviewer must be able to ask "was that the
agents, or was that the policy engine?" and get an answer.

The specification anticipates this. It requires pinned scenario versions, pinned
prompts, recorded model parameters, and versioned policy engines
([§32.6 Determinism](../specification.md#326-determinism)). It also leaves fifteen
questions explicitly open ([§58](../specification.md#58-open-questions)), several of
which have to be answered before any code can be written.

Undocumented decisions in a research platform are not merely inconvenient; they
are a threat to the validity of the research.

## Decision

Use Architecture Decision Records, numbered sequentially, stored in `docs/adr/`,
named `NNNN-kebab-case-title.md`.

An ADR is required for any decision that:

- closes one of the [§58](../specification.md#58-open-questions) open questions;
- constrains a protocol wire format, credential format, or signature scheme;
- selects a language, runtime, datastore, or external dependency that would be
  costly to reverse;
- interprets a **SHOULD** in the specification as a **MUST** or **MUST NOT** for
  this implementation;
- deliberately deviates from the specification.

That last case deserves emphasis. A deviation without an ADR is a bug. A
deviation with an ADR is a design.

ADRs are immutable once accepted. Superseding an ADR means writing a new one and
updating the status lines of both.

## Options considered

### Lightweight Markdown ADRs in the repository (chosen)

Versioned alongside the code they constrain, diffable, reviewable in pull
requests, and readable without tooling.

### An external design-document system

Rejected. It separates the decision from the code, and the two drift. It also
means the published research dataset would be incomplete without a second export
from a second system.

### Long-form RFCs

Rejected as the default. The overhead suppresses recording of small but
load-bearing decisions — exactly the ones that later turn out to have shaped a
result. Nothing prevents an individual ADR from being long when the decision
warrants it.

### No formal record

Rejected. See Context.

## Consequences

### Positive

- Every non-obvious implementation choice becomes auditable, which is the same
  property the platform demands of its participants.
- The published dataset can include the ADR set, letting external researchers
  assess construct validity.
- New contributors can reconstruct reasoning without archaeology.

### Negative

- Ongoing discipline is required. ADRs that lag the code are worse than no ADRs,
  because they mislead.

### Risks accepted

- Some ADRs will be written for decisions that turn out not to matter. This is
  cheaper than the reverse error.

## Revisit when

Never, in practice. If the ADR process itself needs to change, that change is
itself an ADR superseding this one.
