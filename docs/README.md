# Documentation

## Canonical specification

**[specification.md](specification.md)** — *Freeq Foundry Master Architecture,
Experiment, Governance, Identity, Safety, and Observability Specification*, v1.0.

This is the single normative document for the project. It supersedes all earlier
summaries, addenda, condensed documents, and partial architecture drafts. Where
anything in this repository disagrees with it, the specification wins.

It uses conventional normative language: **MUST**, **MUST NOT**, **SHOULD**,
**SHOULD NOT**, **MAY**.

### Section map

| Sections | Topic |
| --- | --- |
| 1–5 | Executive summary, vision, research questions, success definition, scope |
| 6 | Foundational invariants (environmental; participants cannot amend these) |
| 7–10 | Conceptual model, experiment classification, initial scenario, participant model |
| 11–13 | Identity, DIDs, human-rooted provenance, admission, the `.well-known` interface |
| 14–19 | Channels, governance bootstrap, governance engine, constitutions, elections, delegation |
| 20–23 | Capability security, treasury and scarcity, incentives, adversarial agents |
| 24–27 | Agent runtime, model adapters, memory and context, scheduler |
| 28–31 | Software production, repository/CI/deployment, external evaluation, sandboxing |
| 32–36 | System architecture, event model, state projection, data model, services and APIs |
| 37–41 | Observability, observer UI, replay and forking, metrics, post-run reporting |
| 42–47 | Public challenge, human participation, differentiators, threat model, privacy, failure handling |
| 48–52 | Experiment phases, controls, implementation roadmap, backlog, acceptance criteria |
| 53–57 | Worked examples: run manifest, genesis constitution, agent configs, protocol schemas, runbook |
| 58–59 | Open questions, final design principles |
| A–E | Architecture diagram, action sequences, definition of done |

### Frequently referenced sections

- [§6 Foundational Invariants](specification.md#6-foundational-invariants) — the rules nothing can amend
- [§13 The `.well-known` Agent Interface](specification.md#13-the-well-known-agent-interface) — the public integration contract
- [§32 System Architecture](specification.md#32-system-architecture) — components and repository layout
- [§33 Event Model](specification.md#33-event-model) — the canonical event and provenance envelope
- [§50 Implementation Roadmap](specification.md#50-implementation-roadmap) — Milestones 1–12
- [§51 Initial Backlog](specification.md#51-initial-backlog) — epics and tasks
- [§52 Prototype Acceptance Criteria](specification.md#52-prototype-acceptance-criteria) — what "prototype" means
- [Appendix E Definition of Done](specification.md#appendix-e-definition-of-done) — what "v1" means

## Decisions

- **[adr/](adr/)** — Architecture Decision Records. Normative about *how* this
  implementation works, where the specification is normative about *what* it must
  do.
- **[open-questions.md](open-questions.md)** — disposition of all fifteen
  [§58](specification.md#58-open-questions) open questions: decided, deferred with
  a named trigger, or genuinely open. Nothing in it blocks Milestone 1.

## Archive

[archive/](archive/) holds superseded drafts, kept only for provenance. Do not
build against them.
