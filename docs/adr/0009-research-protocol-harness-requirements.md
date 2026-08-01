# ADR-0009: Harness requirements implied by the research protocol

**Status:** Accepted
**Date:** 2026-02-19
**Spec references:** [§32.6](../specification.md#326-determinism), [§33.1](../specification.md#331-canonical-event), [§40.1](../specification.md#401-metric-principles), [§49](../specification.md#49-experimental-controls), [§53](../specification.md#53-example-run-manifest), [§58.6](../specification.md#586-model-attestation), [§58.13](../specification.md#5813-research-rigor)

**Closes open question:** [§58.13 Research rigor](../specification.md#5813-research-rigor)
**Sharpens:** [§58.6 Model attestation](../specification.md#586-model-attestation)
**Implements:** [docs/research-protocol.md](../research-protocol.md)

## Context

The Chief Scientist's ruling on [§58.13](../specification.md#5813-research-rigor)
is recorded in full at [docs/research-protocol.md](../research-protocol.md). It
settles the unit of analysis, the primary outcome, the sample size, the
randomization design, and the multiplicity policy.

Most of it is a statistics document. But a protocol is only real if the harness
can produce the data it requires, and several requirements land on the **event
schema** — which is Milestone 1 work, in flight right now. Discovering them at
Milestone 10, when the observer and report generator are built, would mean
migrating every event type.

This ADR records what the ruling demands of the implementation, not why the
statistics are right.

## Decision

Nine requirements, in rough order of how much they constrain existing design.

### 1. A run clock, distinct from wall time and logical time

The primary outcome is elapsed time from the genesis event to a verified release,
and the termination table permits **pausing the clock** for infrastructure
outages unrelated to participants.

So the platform needs a third temporal notion. It currently has two
([§33.1](../specification.md#331-canonical-event)): `logicalTime`, the canonical
append position, and `wallTime`, the timestamp. Neither answers "how long has
this organization been working?" once pauses exist.

```text
runClock(e) = wallTime(e) - genesisWallTime - Σ paused intervals before e
```

Pauses are events (`run.clock_paused`, `run.clock_resumed`), so the run clock is
a projection rather than stored state, and a replay reconstructs it exactly. The
primary outcome is computed on the run clock, never on a naive wall-clock
difference.

This is the requirement I would most likely have got wrong by default.

### 2. The run manifest is a signed, hashed, first-class artifact

The ruling requires each matched block to hold constant: scenario seed, initial
information allocation, participant-role roster, model snapshots, budgets, prompt
versions, harness version, and evaluator version. And it defines an **epoch** as
the tuple of scenario, harness, prompt set, model roster, and evaluator versions.

The manifest therefore carries the epoch descriptor, the block identity, the arm
assignment, the execution order within the block, and the `τ` in force. It is
canonicalized, hashed, signed by the controller, and emitted as the run's genesis
event payload — so the experimental design is *inside* the tamper-evident record
rather than alongside it in a spreadsheet.

A run whose manifest hash does not match the pre-registered epoch is not part of
the confirmatory set. That is now checkable mechanically.

### 3. Run validity is a separate axis from run outcome

The ruling distinguishes "the organization failed" (an outcome, kept) from "the
harness broke" (invalid, replaced). Conflating them would let a bad result be
reclassified as a bug.

Two independent fields, never derived from one another:

```text
outcome  ∈ { shipped, not_shipped }
validity ∈ { valid, invalid_harness_defect, invalid_infrastructure }
```

### 4. Validity judgements must be recordable before outcome inspection

The ruling states the replacement decision must be made "without inspecting the
run's outcome." This is the single most gameable point in the whole protocol, so
it gets structural enforcement rather than a procedural note.

An invalidation is a signed event carrying an operational reason code. The
analysis pipeline **MUST** reject any confirmatory dataset in which a validity
judgement's `logicalTime` postdates the run's evaluation events. Blindness
becomes a property of the event ordering, which is exactly the kind of thing the
platform is already built to prove
([§6.8](../specification.md#68-historical-integrity-invariant)).

### 5. Success is an evaluator-signed event, and only that

"A vote declaring success does not count." The primary outcome event is emitted
by the evaluator, signed with the evaluator key, and requires all four
conditions: deployed, all mandatory tests passing, minimum operating period
complete, evaluator signature present.

Governance cannot produce this event, and
[§6.7](../specification.md#67-external-objective-invariant) already forbids
modifying the evaluator. The new requirement is that the event be *singular and
identifiable* — the report generator must be able to find "the" success event
without heuristics.

### 6. Model invocation records must pin snapshots

Ten fields per invocation: provider, model identifier, snapshot identifier, API
version, system prompt hash, tool-schema hash, temperature and reasoning
parameters, the identifier the provider *returned*, and the invocation timestamp.

The returned identifier matters most and is easiest to skip. Recording what we
asked for proves intent; recording what came back detects silent endpoint
substitution, which is precisely the drift the ruling is defending against.

### 7. Model identity carries a verification level

The ruling's five-level ladder (§8 of the protocol) becomes a required field on
every model invocation record, and it partly answers
[§58.6](../specification.md#586-model-attestation).

The consequence for reporting is firm: any statement about model behaviour must
be qualified by the verification level of the data behind it, and condition
assignment may never depend on a Level 0–1 claim. The observer must render
operator-asserted and platform-observed model identity differently. Showing them
identically would be a quiet misrepresentation.

### 8. Metrics are tagged by confirmatory tier

[§40.1](../specification.md#401-metric-principles) already requires versioned
metric definitions with identified source events. Add two fields:

```text
tier    ∈ { primary, secondary, exploratory }
ordinal   // gatekeeping position, secondary only
```

Exactly one metric may be `primary`. At most six may be `secondary`, with
distinct ordinals. The registry enforces this, so the multiplicity policy cannot
drift by someone quietly promoting a metric.

### 9. The export bundle includes the pre-registration

[§33.9](../specification.md#339-event-export) requires `events.ndjson`, schemas,
and artifact hashes. Add the run manifest, the epoch descriptor, the metric
registry version, and the hash of the pre-registration statement in force.

A reader can then verify that the analysis matches the plan, which is the entire
point of pre-registering.

## Options considered

### Record all of this as event-schema requirements now (chosen)

The ruling arrived during Milestone 1, when the event schema is still malleable.
Taking it now costs a day; taking it at Milestone 10 costs a migration of every
event type plus the invalidation of any runs already recorded.

### Defer to Milestone 10, when the observer and reports are built

Rejected. Metrics are computed from events, so any field the analysis needs must
exist at the moment the event is written. There is no retrofitting a field onto
history that has already happened — which is, after all, the property we designed
for on purpose.

### Implement the statistics too

Rejected as out of scope for the harness. RMST estimation, permutation tests, and
gatekeeping belong in an analysis package built against the export bundle, not in
the platform. The harness's job is to emit data adequate to the protocol and to
make deviations from the protocol detectable.

### Treat the run clock as a reporting concern rather than a projection

Rejected. If pause intervals are reconstructed by hand at analysis time, two
analysts get two answers and neither is reproducible from the log. Making it a
projection means replay produces it deterministically
([§6.9](../specification.md#69-replay-invariant)).

## Consequences

### Positive

- The experimental design lives inside the tamper-evident record, so a run's
  membership in the confirmatory set is mechanically checkable.
- Analysis blindness is enforced by event ordering rather than by trust.
- Silent model substitution becomes detectable rather than invisible.
- The multiplicity policy cannot erode by quiet metric promotion.

### Negative

- `ModelInvocationRecord` grows substantially. Justified: this is the record that
  makes model-related claims defensible, and it is written once per invocation
  where it is cheap relative to the call itself.
- Three temporal notions is one more than anyone wants. Documented and derived,
  never stored, to limit the damage.
- The scenario and manifest schemas become considerably stricter, which makes
  ad-hoc exploratory runs slightly more annoying to launch. Acceptable — pilots
  can use a relaxed manifest, provided they are labelled pilots.

### Risks accepted

- **The budget is the real risk.** 60 valid runs at `τ` = 12 h is 720 run-hours
  per confirmatory contrast, plus model spend, plus up to six replacements. The
  hard-ceiling machinery in [§21](../specification.md#21-treasury-budgets-and-scarcity)
  is per-run and does not aggregate across a study; a study-level budget ceiling
  is not yet designed and is not in Milestone 6's scope. Flagged rather than
  solved.
- Nothing here prevents an analyst from running the confirmatory comparison and
  then presenting a more flattering exploratory metric as though it were primary.
  Tiering makes that visible in the export; it cannot make it impossible.

## Revisit when

- The first pilot runs produce a between-run standard deviation for the primary
  outcome. The ruling's power calculation assumes ≈ 3 h; a materially different
  value changes the required *n* and should be taken back to the Chief Scientist
  before enrollment.
- A study-level budget ceiling is designed (see Risks).
- A second confirmatory contrast is selected from
  [§49](../specification.md#49-experimental-controls), which will need its own
  pre-registration and may need a different `τ`.
