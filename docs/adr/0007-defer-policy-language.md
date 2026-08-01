# ADR-0007: Defer the policy language decision to Milestone 4

**Status:** Superseded by [ADR-0010](0010-policy-language.md)
**Date:** 2026-02-19
**Spec references:** [§17.3](../specification.md#173-policy-language), [§20](../specification.md#20-capability-security), [§58.11](../specification.md#5811-policy-language), [§50](../specification.md#50-implementation-roadmap)

**Superseded by:** [ADR-0010](0010-policy-language.md) — the five-rule exercise is at [policy-language-exercise.md](../policy-language-exercise.md), and rule 4 decided it as predicted.

**Defers open question:** [§58.11 Policy language](../specification.md#5811-policy-language)

## Context

[§58.11](../specification.md#5811-policy-language) names CEL as "a practical
candidate" while explicitly requiring that "the team should test whether it
cleanly expresses lineage diversity, election results, and capability
constraints."

That sentence is a warning. Those three requirements are unusual:

- **Lineage diversity** — a quorum rule may need "at least three distinct
  terminal human roots", which requires the policy engine to traverse the
  provenance graph, not merely read a flat context
  ([§7.1](../specification.md#71-identity-graph)).
- **Election results** — approval and ranked methods
  ([§18.3](../specification.md#183-election-methods)) involve aggregation and
  tie-breaking that most expression languages are deliberately too weak to
  express.
- **Capability constraints** — attenuation
  ([§20.5](../specification.md#205-capability-attenuation)) requires deciding
  whether one policy expression is strictly narrower than another. That is a
  comparison between programs, not an evaluation of one, and it is undecidable in
  general for a sufficiently expressive language.

The last point is the sharp one and constrains the whole design. A language
expressive enough to state interesting governance rules may be too expressive to
answer "is this delegation narrower than the authority being delegated?"

Choosing now, before those three requirements have been written down as concrete
rules, means choosing on aesthetics.

## Decision

**Defer.** Do not select a policy language before Milestone 4.

This is a deliberate non-decision with a defined trigger, not an oversight.

### What is decided now

1. **Policy expressions are opaque to Milestone 1–3 code.** The
   `PolicyExpression` type is a tagged container:

   ```typescript
   interface PolicyExpression {
     language: string;   // e.g. "cel-v1", "freeq-rules-v1"
     source: string;     // the expression text
     sourceHash: string; // sha256: of the source, per ADR-0004
   }
   ```

   Everything before Milestone 4 stores, hashes, signs, and transports these
   without evaluating them. Nothing may pattern-match on `source`.

2. **The engine is versioned and recorded.** Every authorization decision records
   the engine identifier and version that produced it
   ([§32.6](../specification.md#326-determinism)). Replay must reproduce decisions
   exactly, which means the engine version is part of the run manifest.

3. **Evaluation is pure, total, and bounded.** No I/O, no clock, no network.
   Deterministic given `(expression, context)`. A step or fuel budget with a
   defined outcome on exhaustion — a policy that fails to terminate is a denial,
   never a hang.

4. **Denial is the default.** An expression that errors, times out, or references
   an unknown attribute denies and emits a denied-action event
   ([§20.7](../specification.md#207-denied-actions)). No fail-open path exists.

5. **Genesis rules avoid the problem.** The genesis constitution
   ([§54](../specification.md#54-example-genesis-constitution)) is expressible with
   a small fixed set of built-in predicates. Milestone 4 can begin with those and
   introduce a general language only when a real rule needs one.

### The deciding trigger

Before Milestone 4 implementation, write out — as concrete expressions, in
whatever candidate syntax — these five rules:

1. A quorum requiring N distinct terminal human roots.
2. An approval-voting election with a documented tie-break.
3. A capability grant scoped to one repository path and one branch pattern.
4. An attenuated re-delegation of rule 3, plus a mechanical check that it is
   strictly narrower.
5. A sunset clause ([§17.7](../specification.md#177-sunset-clauses)) evaluated
   against logical time.

Rule 4 is the discriminator. Candidates: CEL, a purpose-built rule DSL, Rego,
Datalog, or a restricted evaluated subset. The outcome is a new ADR superseding
this one.

## Options considered

### Defer with an explicit interface and trigger (chosen)

Unblocks Milestones 1–3, which need to carry policy expressions but not evaluate
them, while forcing the decision to be made against real requirements.

### Adopt CEL now

Rejected as premature. It is likely the right answer for rules 1–3 and 5, has
good multi-language support, and is designed for exactly this niche. But rule 4
— mechanical attenuation checking — is not something CEL offers, and discovering
that after building on it is expensive.

### Design a bespoke DSL now

Rejected. Attractive because attenuation checking is tractable if you design the
language for it — restrict to conjunctions of comparisons over a fixed attribute
set and narrowing becomes decidable. But designing a language before knowing the
rules is how languages acquire features nobody needs and lack the one that
matters.

### Rego / OPA

Rejected for now. Excellent for capability authorization and battle-tested. But
Datalog-with-negation semantics are hard for agents to *generate correctly*, and
agents writing their own governance rules is the entire point
([§16.9](../specification.md#169-governance-automation)). Legibility to a model is
a real selection criterion here, which is unusual and easy to overlook.

### Arbitrary sandboxed code

Rejected. Non-terminating, non-analyzable, and a sandbox escape surface in the
authorization path — the worst possible place for one.

## Consequences

### Positive

- Milestones 1–3 proceed without a decision they cannot yet inform.
- The five-rule exercise turns an aesthetic argument into an experiment.
- The tagged `PolicyExpression` container means multiple languages can coexist,
  and migration does not invalidate historical expressions.

### Negative

- Governance cannot be exercised end to end until Milestone 4. Acceptable: it is
  Milestone 4.
- Storing unevaluated expressions risks accumulating expressions no engine can
  evaluate. Mitigated by the `language` tag and by refusing unknown languages at
  admission.

### Risks accepted

- The five-rule exercise may show that no single language covers all cases,
  requiring built-in predicates for election aggregation alongside a general
  language for conditions. That is a legitimate outcome, and better discovered by
  the exercise than by production failure.

## Revisit when

**Immediately before Milestone 4 implementation begins.** The five rules above are
the entry criterion. This ADR is superseded by whatever that exercise concludes.
