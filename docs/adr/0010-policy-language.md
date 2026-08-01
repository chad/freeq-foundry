# ADR-0010: A restricted conjunctive policy language

**Status:** Accepted
**Date:** 2026-02-19
**Spec references:** [§17.3](../specification.md#173-policy-language), [§18.3](../specification.md#183-election-methods), [§20.4](../specification.md#204-authorization-decision), [§20.5](../specification.md#205-capability-attenuation), [§58.11](../specification.md#5811-policy-language)

**Supersedes:** [ADR-0007](0007-defer-policy-language.md)
**Closes open question:** [§58.11 Policy language](../specification.md#5811-policy-language)
**Evidence:** [docs/policy-language-exercise.md](../policy-language-exercise.md)

## Context

[ADR-0007](0007-defer-policy-language.md) deferred this decision and set a gate:
five concrete rules, with mechanical attenuation checking named as the
discriminator. The exercise is written up in
[policy-language-exercise.md](../policy-language-exercise.md).

Its finding was that no single language handles all five cases well, and that the
problem should be partitioned rather than solved by one mechanism. The
discriminator decided the part that matters: a general-purpose expression language
cannot soundly answer "is this grant strictly narrower than its parent?" without a
constraint solver, and an unsound answer in the authorization path is a
privilege-escalation bug.

## Decision

Three mechanisms, each matched to a different concern.

### 1. Conditions: a restricted conjunctive language

`freeq-rules-v1`. A policy expression is a **conjunction of comparisons over a
fixed attribute vocabulary**. No disjunction, no negation, no arithmetic, no
loops, no user-defined functions.

```
repo.path glob "packages/api/**" and repo.branch glob "feature/*"
proposal.distinct_lineages >= 3
run.logical_time < 5000
```

Grammar:

```
expression  := comparison ( "and" comparison )*
comparison  := attribute operator literal
operator    := "=" | "!=" | "<" | "<=" | ">" | ">=" | "glob" | "in"
attribute   := IDENT ( "." IDENT )*
literal     := STRING | INTEGER | "[" literal ( "," literal )* "]"
```

Four properties follow from the restriction, and each is why the restriction
exists:

- **Total.** No loops, so evaluation terminates by construction rather than by a
  fuel budget bolted on afterwards.
- **Pure.** No I/O, no clock, no randomness. Deterministic given
  `(expression, context)`, which is what replay requires.
- **Narrowing is decidable.** See below.
- **Legible to a model.** Agents write their own governance rules
  ([§16.9](../specification.md#169-governance-automation)), so being easy to
  *generate correctly* is a genuine selection criterion — one that disfavoured
  Rego regardless of its other merits.

### 2. Aggregation: named built-ins, not expressions

Election methods are **data**: a named method from a closed set plus an ordered
tie-break list.

```yaml
method: approval
tiebreak: [earliest_nomination, lowest_did]
```

Lineage aggregates are **attributes the harness computes**, not expressions the
language evaluates: `proposal.distinct_lineages`, `proposal.yes_count`.

This was the exercise's first finding, and it is a deliberate reduction in
expressiveness. An agent inventing a novel voting method inside a policy
expression is a bug surface, not a feature; election outcomes must be
deterministic and auditable above all
([§18.3](../specification.md#183-election-methods)).

### 3. Lifecycle: structural fields, not expressions

Sunset ([§17.7](../specification.md#177-sunset-clauses)) and entrenchment
([§17.6](../specification.md#176-entrenchment)) are fields on the rule. A
projection computes active rules without evaluating anything, which is faster and
easier to audit than a sunset condition hidden inside an expression.

### Attenuation

`narrows(child, parent)` returns a definite answer:

| Comparison | Child narrows parent when |
| --- | --- |
| `x <= n` | child's `n` ≤ parent's `n` |
| `x >= n` | child's `n` ≥ parent's `n` |
| `x = v` | parent is `x = v`, or parent's constraint on `x` admits `v` |
| `x in S` | child's `S` ⊆ parent's `S` |
| `x glob p` | child's pattern is contained in parent's, for the permitted glob subset |
| extra conjunct | always narrows |
| missing conjunct | never narrows |

Conjunction-only is what makes this sound. With disjunction, containment needs a
solver; without it, every case is a direct comparison.

The checker is **conservative**: when containment cannot be established it returns
false, and the attenuation is refused. Refusing a legitimate narrowing is an
inconvenience; permitting an illegitimate one is a privilege escalation.

### Denial is the default

An expression that fails to parse, references an unknown attribute, or errors
denies, and emits a denied-action event
([§20.7](../specification.md#207-denied-actions)). There is no fail-open path. An
unknown attribute is a denial rather than a `false`, because silently treating a
typo as "condition not met" would make a rule quietly permissive in a way nobody
would notice.

### Versioning

`PolicyExpression.language` is `"freeq-rules-v1"`. The tagged container from
ADR-0007 is unchanged, so a future language can coexist and historical expressions
remain interpretable. Every authorization decision records the engine version, so
replay reproduces decisions exactly
([§32.6](../specification.md#326-determinism)).

## Options considered

Full comparison in
[policy-language-exercise.md](../policy-language-exercise.md). Summarised:

### CEL

Rejected. Rules 1 and 2 need `flatten`, `distinct`, and sorting, none of which CEL
has — so it would be *CEL plus our extensions*, and the extensions would be doing
the work. Rule 4 is undecidable without a solver.

### Rego / OPA

Rejected, despite being the best fit for rules 1 and 3 on the merits. Rule 4 is
harder than in CEL because negation and rule composition complicate containment.
Separately and importantly, Datalog-with-negation semantics are hard for a model to
*generate correctly*, and that disqualifies it for a system whose agents write
their own rules.

### Datalog

Rejected. Containment is decidable for conjunctive queries, which is genuinely
promising, but sunset clauses and time comparisons push past that fragment and the
decidability goes with them.

### A general-purpose DSL with disjunction

Rejected. Disjunction is precisely what makes attenuation undecidable. Its absence
is the design.

### Sandboxed code

Rejected. Non-terminating, non-analyzable, and a sandbox escape surface in the
authorization path — the worst possible place for one.

## Consequences

### Positive

- Attenuation is answered by construction, with no solver in the authorization
  path.
- Evaluation is total and pure, so replay reproduces authorization decisions
  exactly.
- Small enough to audit in one sitting and to implement in another language.
- Election determinism is structural rather than dependent on what an agent wrote.

### Negative

- **No disjunction.** "Path A or path B" requires two grants. More verbose, and
  the reason the rest works.
- **No arithmetic.** Derived quantities are computed by the harness and offered as
  attributes.
- **No attribute-to-attribute comparison.** `yes_count > no_count` is not
  expressible; the harness offers `yes_share_pct` instead. Found by testing the
  exercise's own rule 1, which I had first written in the unsupported form.
  Supporting it would mean comparing two *attribute-relative* constraints during
  narrowing — precisely the reasoning this ADR excludes. The parser names this case
  explicitly, because agents will reach for it.
- **A fixed attribute vocabulary.** Agents cannot invent attributes; new ones need
  a platform release. This is a real constraint on emergent governance and the
  most likely reason to revisit.
- **We maintain a language**, including its parser and narrowing checker. Small,
  but ours.

### Risks accepted

- The conservative narrowing checker will refuse some legitimate attenuations.
  Preferred to the alternative in this position.
- The attribute vocabulary may prove too small for governance agents actually
  want. Watch for proposals that fail because they cannot be expressed — that is
  the signal, and it is worth instrumenting.

## Revisit when

- Agents repeatedly need a rule the vocabulary cannot express. Extending the
  vocabulary is the first response; adding disjunction means giving up mechanical
  attenuation and needs its own ADR.
- A capability model emerges that does not require narrowing checks, which would
  remove the constraint that drove this decision entirely.
