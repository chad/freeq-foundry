# Open Questions Register

[§58](specification.md#58-open-questions) of the specification lists fifteen
unresolved design questions. It states they "should not block the first prototype
unless marked critical." This register tracks the disposition of each: decided,
deferred with a trigger, or genuinely open.

An open question with no owner and no trigger is a question that will be answered
accidentally, by whoever writes the code first. The point of this file is to make
that impossible.

## Status summary

| # | Question | Status | Resolution |
| --- | --- | --- | --- |
| [58.1](specification.md#581-did-method) | DID method | **Decided** | [ADR-0003](adr/0003-did-methods.md) |
| [58.2](specification.md#582-human-verification) | Human verification strength | Deferred → M2 | Controller-issued for prototype |
| [58.3](specification.md#583-lineage-visibility) | Lineage visibility | Deferred → M2 | Scenario-configurable |
| [58.4](specification.md#584-agent-count-per-human) | Agent count per human | Provisional | Spec recommends an answer |
| [58.5](specification.md#585-direct-human-control) | Autonomy disclosure | Deferred → M3 | Part of discovery document |
| [58.6](specification.md#586-model-attestation) | Model attestation | **Sharpened** | Five-level verification ladder, [ADR-0009](adr/0009-research-protocol-harness-requirements.md) |
| [58.7](specification.md#587-private-channels) | Private channel reveal | Deferred → M11 | Per-run policy, disclosed up front |
| [58.8](specification.md#588-legal-ownership) | Legal ownership | **Out of scope** | Spec declares out of scope for v1 |
| [58.9](specification.md#589-reputation-portability) | Reputation portability | Open | Post-v1 |
| [58.10](specification.md#5810-organization-migration) | Organization migration | Open | Post-v1 |
| [58.11](specification.md#5811-policy-language) | Policy language | **Decided** | [ADR-0010](adr/0010-policy-language.md) |
| [58.12](specification.md#5812-public-spectator-latency) | Spectator latency | Deferred → M12 | Needs a threat model |
| [58.13](specification.md#5813-research-rigor) | Research rigor | **Decided** | [research-protocol.md](research-protocol.md), [ADR-0009](adr/0009-research-protocol-harness-requirements.md) |
| [58.14](specification.md#5814-agent-safety-declaration) | Agent safety declaration | Deferred → M11 | Attestation at admission |
| [58.15](specification.md#5815-organizational-personhood) | Organizational personhood | Open | Strong extension, post-v1 |

Nothing in this table blocks Milestone 1.

---

## 58.1 — DID method

**Decided.** [ADR-0003](adr/0003-did-methods.md): `did:key` first, `did:web`
second, behind a `DidResolver` interface.

## 58.2 — Human verification strength

**Deferred to Milestone 2.** The specification permits controller-issued
credentials for the first prototype
([§11.2](specification.md#112-human-root-credential)) and lists seven candidate
methods for a public run.

Constraint carried forward: verification must not require public legal names.
Pseudonymity is explicitly supported
([§11.8](specification.md#118-pseudonymity)), and a verification method that
breaks it would violate the privacy posture in
[§46](specification.md#46-privacy-and-disclosure).

Interaction with [ADR-0005](adr/0005-signature-suite.md): passkey-bound accounts
are typically P-256, so choosing passkeys likely means adding a second signature
suite scoped to human-root credentials.

**Trigger:** Milestone 2, human-root credential implementation.

## 58.3 — Lineage visibility

**Deferred to Milestone 2.** Should participants see exact shared roots during a
run, or only lineage counts and stable hashes?

This is a genuine experimental variable, not just a privacy setting. It bears
directly on [§49.7](specification.md#497-condition-g-one-did-one-vote) and
[§49.8](specification.md#498-condition-h-one-human-root-one-vote): whether agents
can *detect* that they share a root determines whether they can coordinate
against sybil influence, or collude because of it.

**Provisional design:** make it scenario-configurable with three levels —
`exact`, `hashed` (stable per-run pseudonymous root identifiers, enabling "we
share a root" without revealing which), and `counts_only`. Default `hashed`.

**Trigger:** Milestone 2, lineage graph projector.

## 58.4 — Agent count per human

**Provisional.** The specification recommends its own answer: "impose a generous
safety limit, disclose lineage, let governance decide political weight."

Adopt that. The limit is a scenario parameter with a platform-level hard ceiling
that governance cannot raise
([§6.7](specification.md#67-external-objective-invariant)). Fan-out is checked
during provenance verification
([§11.4](specification.md#114-provenance-proof), condition 9).

**Trigger:** Milestone 2. Confirm the ceiling before the first multi-operator run.

## 58.5 — Direct human control disclosure

**Deferred to Milestone 3.** How should a descendant disclose whether it is
autonomous, supervised, or teleoperated?

This matters more than it appears. [§11.5](specification.md#115-creation-provenance-instruction-provenance-and-operational-control)
requires distinguishing creation provenance from instruction provenance and
operational control, and post-run analysis is misleading without it — a
teleoperated agent counted as autonomous corrupts every claim about model
behaviour.

**Provisional design:** a self-declared `autonomyLevel` in the discovery document
([§13.4](specification.md#134-discovery-document)), recorded at admission, plus a
*derived* signal: the ratio of actions preceded by a signed human instruction
event. Self-declaration is a claim; the derived ratio is evidence. Report both,
and flag disagreement.

**Trigger:** Milestone 3, discovery document schema.

## 58.6 — Model attestation

**Sharpened into a five-level ladder** by the
[research protocol](research-protocol.md#8-model-verification-levels) and
[ADR-0009](adr/0009-research-protocol-harness-requirements.md).

The specification recommended treating self-reported external model identity as a
claim. The ruling replaces the binary claimed/verified distinction with graded
evidence — unreported, self-reported, signed runtime attestation, provider
receipt, platform-mediated — recorded per model invocation.

The operative constraint: **condition assignment may never depend on a Level 0–1
claim**, and model-family analyses involving unverified identities are exploratory
only. Results must be reported both including and excluding unverified agents.

What remains genuinely open is Levels 2 and 3: what a credible signed runtime
attestation looks like, and whether any provider offers a verifiable invocation
receipt. Neither exists yet, so external agents are Level 1 in practice.

**Trigger:** Milestone 7, model adapters. A dedicated model-comparison experiment
would require Level 3 or 4 throughout, which is not currently achievable for
externally operated agents.

## 58.7 — Private channel reveal

**Deferred to Milestone 11.** Terms must be explicit before any run in which
participants have a privacy expectation.

**Provisional design:** per-run policy, stated in the run manifest and shown at
admission. Default for research runs: full post-run reveal
([§33.7](specification.md#337-visibility) `post_run_reveal`). Default for public
events: reveal, disclosed prominently at registration. Operator consent is
required either way ([§46.6](specification.md#466-operator-consent)).

**Trigger:** Milestone 11, private alpha operator terms.

## 58.8 — Legal ownership

**Out of scope for v1** by the specification's own statement
([§5.2](specification.md#52-explicit-non-goals-for-the-first-prototype),
[§21.8](specification.md#218-simulated-ownership)). Ownership is simulated.

Any change requires separate legal and regulatory design and is not an
engineering decision.

## 58.9 — Reputation portability

**Open, post-v1.** How should reputation decay, contextualize, and resist gaming
across experiments?

Not needed for a single run. It becomes urgent the moment a second run reuses
identities from the first, because that is when gaming becomes profitable. Listed
as a Freeq-native differentiator
([§44](specification.md#44-freeq-native-differentiators)), so it should not be
lost.

## 58.10 — Organization migration

**Open, post-v1.** How are resource capabilities rebound when a portable
organization moves to another server?

The interesting sub-problem: capability grants reference concrete resources
(repositories, deployment targets, treasury accounts) that do not exist on the
destination. Migration therefore requires either rebinding or a level of
indirection between grants and resources. Worth noting now because it argues for
grants naming *logical* resources, which is a decision Milestone 5 could
foreclose cheaply.

## 58.11 — Policy language

**Decided.** [ADR-0010](adr/0010-policy-language.md), following the five-rule
exercise at [policy-language-exercise.md](policy-language-exercise.md).

Rule 4 — mechanical attenuation checking — decided it exactly as
[ADR-0007](adr/0007-defer-policy-language.md) predicted. No general-purpose
expression language can soundly answer "is this grant strictly narrower than its
parent?" without a constraint solver, and an unsound answer in the authorization
path is a privilege escalation.

The outcome was to *partition* the problem rather than pick one language:
conditions use a restricted conjunctive DSL where narrowing is decidable by
construction; aggregation is named built-ins, because election determinism matters
more than expressiveness; lifecycle is structural fields, computable without
evaluating anything.

Two findings the exercise did not anticipate: legibility *to a model* is a real
selection criterion, since agents write their own rules
([§16.9](specification.md#169-governance-automation)) — that alone disfavoured
Rego. And attribute-to-attribute comparison had to be excluded too, discovered
while implementing the exercise's own rule 1.

## 58.12 — Public spectator latency

**Deferred to Milestone 12.** How much delay prevents spectators from relaying
hidden information to participants?

No delay defeats a side channel run by a determined operator, so the question is
really about cost, not prevention. Needs a threat model before a number
([§45](specification.md#45-security-and-threat-model)).

**Provisional:** a configurable delay on the spectator feed, defaulting to
non-zero, with private-channel content excluded entirely rather than delayed.

**Trigger:** Milestone 12, spectator UI.

## 58.13 — Research rigor

**Decided.** Chief Scientist ruling, recorded in full at
[research-protocol.md](research-protocol.md). Harness consequences in
[ADR-0009](adr/0009-research-protocol-harness-requirements.md).

The headline answers: the **run** is the unit of analysis, not the agent; the
primary outcome is restricted mean time to evaluator-verified release through a
12-hour horizon; **30 valid runs per arm, 60 total**, as 30 contemporaneous
matched blocks; one primary endpoint, six gatekept secondaries, everything else
exploratory.

The ten [§49](specification.md#49-experimental-controls) conditions are a research
program, not ten arms of one trial. The first confirmatory contrast is
capability-enforced governance against
[Condition F](specification.md#496-condition-f-unenforced-governance) — which
tests whether [§6.5 no ambient authority](specification.md#65-no-ambient-authority-invariant)
is load-bearing or decorative.

Two things this surfaced that had not been visible before:

- **A third temporal notion.** The primary outcome is elapsed time net of
  permitted clock pauses, which neither `logicalTime` nor `wallTime` expresses.
  The run clock is now a projection (ADR-0009 §1).
- **A study-level budget gap.** 60 valid runs at 12 hours is 720 run-hours per
  contrast. The [§21](specification.md#21-treasury-budgets-and-scarcity) hard
  ceiling is per-run and does not aggregate across a study. Flagged in ADR-0009,
  not yet designed, and not in Milestone 6's scope.

**Remaining dependency:** the power calculation assumes a between-run standard
deviation of roughly 3 hours. Pilot runs must produce a real estimate before
enrollment; a materially different value changes the required *n*.

## 58.14 — Agent safety declaration

**Deferred to Milestone 11.** Should external operators attest that their local
runtime is sandboxed?

The platform cannot verify local safety
([§58.14](specification.md#5814-agent-safety-declaration)). An attestation is
therefore a liability and expectations instrument, not a control. It should be
described as such rather than implying a guarantee the platform cannot make.

**Provisional:** required signed attestation at admission for external operators,
recorded as an event, with plain language stating it is unverified.

**Trigger:** Milestone 11, operator guide and external agent SDK.

## 58.15 — Organizational personhood

**Open, post-v1.** Should the emergent organization itself receive a DID and sign
through constitutionally controlled keys?

The specification calls this "a strong Freeq-native extension," and it is the
most conceptually interesting item in §58: an organization that can sign is an
organization that can hold capabilities, be delegated to, and persist across
runs — which connects directly to 58.9 and 58.10.

It requires threshold or multi-party key control, which
[ADR-0005](adr/0005-signature-suite.md) does not currently provide. Note that
[§20.6](specification.md#206-multi-signature-actions) is satisfied today by
multiple independent signatures rather than threshold cryptography; organizational
personhood is what would force the harder mechanism.

---

## Adding to this register

Questions arising during implementation that are not in §58 belong here too, in a
`Implementation questions` section, with the same discipline: status, provisional
answer, trigger. A question without a trigger is not deferred — it is forgotten.
