# Policy Language Exercise

**Status:** Complete
**Date:** 2026-02-19
**Gate for:** [ADR-0007](adr/0007-defer-policy-language.md)
**Outcome:** [ADR-0010](adr/0010-policy-language.md)

[ADR-0007](adr/0007-defer-policy-language.md) deferred the policy language choice
and set an entry criterion: write out five specific rules as concrete expressions
before choosing. Rule 4 was named the discriminator.

This is that exercise. The candidates were CEL, Rego, Datalog, a purpose-built
DSL, and a restricted evaluated subset.

## Rule 1 — Quorum requiring N distinct terminal human roots

> A proposal passes only with at least 3 distinct terminal human roots voting yes.

**CEL**

```cel
proposal.votes.filter(v, v.choice == "yes")
  .map(v, v.voter.terminalHumanRoots)
  .flatten()
  .distinct()
  .size() >= 3
```

CEL has no `flatten` or `distinct` in its standard library. Both would be custom
extension functions, so this is really *CEL plus two functions we write*.

**Rego** — natural. Comprehensions and set semantics are what Rego is for.

```rego
distinct_roots := {root |
  some v in input.proposal.votes
  v.choice == "yes"
  some root in v.voter.terminal_human_roots
}
passes { count(distinct_roots) >= 3 }
```

**DSL** — needs a built-in aggregate, since lineage counting is not expressible
from comparisons alone:

```
quorum: distinct_lineages(votes where choice = yes) >= 3
```

**Verdict:** all three work. Rego is cleanest; CEL needs extensions; a DSL needs a
built-in. Not discriminating.

## Rule 2 — Approval voting with a documented tie-break

> Elect by approval count. Tie broken by earliest nomination; then by lowest DID
> lexicographically.

**CEL** — poor. Argmax with a multi-level tie-break requires sorting, which CEL
deliberately lacks. Every candidate ranking would be an extension function, at
which point the language is not doing the work.

**Rego** — expressible but awkward; deterministic tie-breaking in a language whose
sets are unordered fights the semantics.

**DSL** — trivial, because election methods are named rather than derived:

```
method: approval
tiebreak: [earliest_nomination, lowest_did]
```

**Verdict: aggregation should not be in the expression language at all.** Election
methods are a small closed set ([§18.3](specification.md#183-election-methods)) that
must be deterministic and auditable. Making them *data* — a named method plus an
ordered tie-break list — is better than making them *expressible*. An agent
inventing a novel voting method inside a policy expression is a bug surface, not a
feature.

This was the first real finding.

## Rule 3 — Capability scoped to a repository path and branch pattern

> Grant `repo.commit` limited to `packages/api/**` on branches matching
> `feature/*`.

All three candidates handle this comfortably. It is a conjunction of pattern
matches:

```
repo.commit where path glob "packages/api/**" and branch glob "feature/*"
```

**Verdict:** not discriminating.

## Rule 4 — Mechanical attenuation check *(the discriminator)*

> Given rule 3, verify that a re-delegated grant is **strictly narrower**.

This is a comparison between two programs, not an evaluation of one.

**CEL** — undecidable in general. `a > 5` versus `a > 3 && a < 100`: no
sound-and-complete procedure without a solver. Approximating with a solver is a
large dependency in the authorization path, and an unsound approximation in this
position is a privilege-escalation bug.

**Rego** — same, worse. Negation and rule composition make containment harder
still.

**Datalog** — containment is decidable for conjunctive queries, which is
promising. But expressing sunset clauses and time comparisons pushes past
conjunctive queries, and the decidability disappears with them.

**Restricted DSL** — decidable *by construction* if the language is restricted to
conjunctions of comparisons over a fixed attribute set:

- `glob(a) ⊆ glob(b)` — decidable for the glob subset we permit
- `x ∈ S₁ ⊆ x ∈ S₂` iff `S₁ ⊆ S₂`
- `x ≤ n₁` narrows `x ≤ n₂` iff `n₁ ≤ n₂`
- adding a conjunct always narrows
- **disjunction is not permitted**, which is what keeps this tractable

**Verdict: the discriminator decides it.** A general-purpose expression language
cannot answer the attenuation question soundly without a solver, and an unsound
answer here is a security hole. A restricted language answers it by construction.

ADR-0007 anticipated exactly this: "A language expressive enough to state
interesting governance rules may be too expressive to answer 'is this delegation
narrower than the authority being delegated?'"

## Rule 5 — Sunset clause against logical time

> This rule lapses at logical time 5000.

Trivial in all candidates — and in fact better handled *outside* the expression
language, as a field on the rule
([§17.7](specification.md#177-sunset-clauses)). A projection can then compute
active rules without evaluating anything, which is both faster and easier to
audit.

**Verdict:** not discriminating, and argues for keeping lifecycle metadata
structural rather than expressed.

## Conclusion

No single language covers all five cases well — which ADR-0007 listed as a
legitimate possible outcome. The exercise instead partitioned the problem:

| Concern | Mechanism | Why |
| --- | --- | --- |
| Conditions (rules 1, 3, 5) | Restricted DSL: conjunctions of comparisons | Decidable attenuation |
| Aggregation (rules 1, 2) | Named built-ins: `distinct_lineages`, election methods | Determinism and auditability beat expressiveness |
| Lifecycle (rule 5) | Structural fields on the rule | Computable without evaluation |

Three further considerations, none of which appeared in the original candidate
comparison but all of which matter here:

1. **Agents must generate these correctly.** Agents writing their own governance
   rules is the entire point
   ([§16.9](specification.md#169-governance-automation)). Legibility to a model is
   a real selection criterion, and it disfavours Rego's Datalog-with-negation
   semantics regardless of the other merits.
2. **Denial must be the default and evaluation must be total.** A restricted
   language has no loops and therefore terminates by construction, rather than by
   a fuel budget bolted on.
3. **The audit surface is in the authorization path.** CEL and Rego are each
   substantial dependencies sitting where a bug is a privilege escalation.

Decision recorded in [ADR-0010](adr/0010-policy-language.md).

## What we give up

Honestly stated, because a decision without acknowledged costs is a rationalization:

- **No disjunction.** "Path A or path B" needs two grants. Slightly more verbose,
  and the thing that makes attenuation decidable.
- **No arithmetic beyond comparison.** No `budget * 0.1`. Derived quantities must
  be computed by the harness and offered as attributes.
- **A fixed attribute vocabulary.** Agents cannot invent attributes. New ones
  require a platform release, which is a real constraint on emergent governance and
  the most likely reason to revisit this.
- **No attribute-to-attribute comparison.** Discovered while implementing: rule 1
  above, written naturally as `yes_count > no_count`, is not expressible. The
  harness offers `yes_share_pct`. Allowing it would require comparing two
  attribute-relative constraints during narrowing, which is the reasoning we
  excluded — so this is the restriction working as intended rather than a gap, but
  it is a sharper constraint than the exercise anticipated.
- **We are maintaining a language.** Small, but ours, including its parser and its
  narrowing checker.
