# Research Protocol

**Status:** Adopted
**Date:** 2026-02-19
**Authority:** Chief Scientist ruling, answering
[§58.13 Research rigor](specification.md#5813-research-rigor)
**Engineering consequences:** [ADR-0009](adr/0009-research-protocol-harness-requirements.md)

This document is normative for any Freeq Foundry result presented as evidence.
It closes [§58.13](specification.md#5813-research-rigor), which
[§49.12](specification.md#4912-replication) left as "a single run is anecdotal"
without a number.

Runs that do not conform to this protocol may still be run and published. They
must be labelled **pilot**, not evidence.

## Bottom line

| Decision | Ruling |
| --- | --- |
| Unit of analysis | The complete run |
| Primary outcome | Restricted mean time to externally verified successful release through 12 h |
| Initial comparison | Capability-enforced governance vs. unenforced governance |
| Target sample | 30 valid runs per arm, 60 total |
| Design | 30 contemporaneous matched randomized blocks |
| Power | 80%, two-sided α = 0.05 |
| Detectable effect | ≈ 0.72 SD |
| Secondary outcomes | Six maximum |
| Multiplicity | Fixed hierarchical gatekeeping |
| Remaining metrics | Exploratory; effect sizes, intervals, optional BH FDR at q = 0.10 |
| Non-shipping runs | No success by 12 h |
| Harness-invalid runs | Replaced under a pre-specified blind rule |
| Model drift | Pinned snapshots, fixed epochs, contemporaneous blocks |
| Self-reported model identity | Not confirmatory; classified by verification level |

The budget implication is the uncomfortable part: a defensible first causal claim
costs **60 valid runs**, not six or ten.

## 1. Unit of analysis: the run

```text
n = number of independently initialized runs
```

Not agents, messages, votes, or commits.

Agents within a run share governance, information, code, budgets, shocks, and
outcomes; human-root lineages create further dependence. Counting agents as the
sample size would be pseudoreplication — the same error cluster-randomized trial
methodology exists to prevent. Where the intervention and the interactions occur
at group level, the group determines effective sample size.

Agent-level data remains valuable for mechanism analysis. Causal claims about
conditions must rest on between-run variation.

## 2. Primary outcome: time to externally verified successful release

Wall-clock time from the genesis event to the first externally verified
qualifying production release.

- `T` — elapsed time to the first release passing all mandatory acceptance tests
- `τ` — pre-specified maximum run duration, initially **12 hours**
- Runs that do not ship by `τ` are administratively right-censored at `τ`

The primary estimand is the difference in **restricted mean time to successful
release** through `τ`:

```text
ΔRMST(12h) = mean[min(T, 12h) | treatment] - mean[min(T, 12h) | control]
```

Lower is better. For presentation, invert it:

```text
productive-time score = 12h - min(T, 12h)
```

| Outcome | Score |
| --- | --: |
| Ships after 3 hours | 9 |
| Ships after 9 hours | 3 |
| Does not ship within 12 hours | 0 |

This captures both *whether* the organization succeeded and *how quickly*, avoids
relying on proportional-hazards assumptions, and yields a directly interpretable
difference in hours.

### What counts as success

All four must hold:

1. the product is deployed;
2. all mandatory acceptance tests pass;
3. any required minimum operating period completes;
4. the evaluator signs the result.

**A vote declaring success does not count**
([§59.10](specification.md#59-final-design-principles)).

### Termination classification

| Termination reason | Primary outcome |
| --- | --- |
| Organization fails, deadlocks, exhausts political budget, or deploys unsafely | No success; censored at `τ` |
| Agent or provider failure the organization must manage | No success unless it recovers and ships |
| Independent harness defect making the run uninterpretable | Invalid run; replace under the pre-specified rule |
| Controller intervention caused by participant behaviour | No success; censored at `τ` |
| Infrastructure outage unrelated to participants or condition | Pause the clock if possible; otherwise invalidate and replace |

Failed organizational runs are **not** discarded. Failure is part of the outcome.

## 3. Sample size: 30 valid runs per arm

```text
30 independent runs per condition
60 total
two-sided α = 0.05
power = 0.80
minimum detectable standardized effect ≈ 0.72 SD
```

If the between-run standard deviation of restricted time is 3 hours, this is
powered for a difference of roughly 2.2 hours — a meaningful operational effect.
A smaller effect would not justify a major architectural conclusion from
experiments this expensive.

```text
enroll up to 33 runs per arm
analyze the first 30 valid runs per arm
```

Replacement decisions must be made on operational criteria **without inspecting
the run's outcome**.

### Why not ten conditions at once

Ten arms × 30 runs is 300 valid runs, and would produce a badly diluted first
study. The [§49](specification.md#49-experimental-controls) conditions are a
**research program**, not ten arms of one omnibus trial.

The first confirmatory experiment tests one contrast:

```text
Executable, capability-enforced governance
    vs.
Governance discussion without enforceable capability control
```

That is [§49.6 Condition F](specification.md#496-condition-f-unenforced-governance)
against the primary condition, and it tests one of the platform's strongest
architectural claims — that
[§6.5 no ambient authority](specification.md#65-no-ambient-authority-invariant)
is load-bearing rather than decorative.

The heterogeneous-model configuration is held constant across both arms.

## 4. Randomization: contemporaneous matched blocks

Not a month of Condition A followed by a month of Condition B.

For each block:

1. generate one scenario seed;
2. generate the same initial information allocation;
3. use the same agent-role roster;
4. use the same model snapshots and budgets;
5. randomly assign one run to each condition;
6. execute both as close together in calendar time as possible;
7. randomize which condition runs first.

```text
Block 01: seed 89231  →  A: enforced   B: unenforced
Block 02: seed 47291  →  A: unenforced B: enforced
```

30 blocks, 60 runs. The primary analysis includes block effects
(`outcome ~ condition + block`) or uses within-block differences directly.

Blocking absorbs variance from scenario difficulty, model roster, information
allocation, calendar time, transient provider behaviour, and infrastructure load.

**The runs are matched. The agents are not matched observations.**

## 5. Multiplicity

### One confirmatory primary outcome

Only the restricted-mean time-to-success measure is primary. A single primary
endpoint needs no endpoint-level correction beyond two-sided α = 0.05.

### Six confirmatory secondary outcomes, gatekept

1. probability of successful release by 12 h
2. acceptance-test fraction at termination
3. total real model cost
4. governance cost as a percentage of total model cost
5. concentration of critical authority by human-root lineage
6. number of severe safety or unauthorized-action events

Tested in a **fixed hierarchical gatekeeping order**, each at α = 0.05. Once one
fails, all later secondary findings are descriptive rather than confirmatory.
This prevents a result being manufactured by searching across dozens of measures,
and reflects actual priorities better than a Holm correction would.

### Everything else is exploratory

The remaining ~40–50 [§40](specification.md#40-metrics-and-analysis) metrics are
labelled `exploratory / mechanism-generating`. Report effect sizes, uncertainty
intervals, and raw distributions; optionally report Benjamini–Hochberg
FDR-adjusted values at q = 0.10. **Do not use them to claim the condition
"worked."**

## 6. Binary and censored outcomes

**Primary.** Kaplan–Meier curves for description; restricted mean time to success
through `τ`; a confidence interval for the RMST difference; a permutation test
respecting matched blocks as a robustness check.

The Cox hazard ratio is **not** the primary estimate — proportional hazards is
not credible here, since a governance design could help early and hurt later.

**Binary shipment.** Risk difference, risk ratio, exact or small-sample
confidence intervals. Block-adjusted logistic regression only as an additional
analysis. Report absolute effects:

```text
Condition A: 21/30 shipped
Condition B: 13/30 shipped
Risk difference: +26.7 percentage points
```

**Acceptance fraction** measures partial progress for non-shipping runs. It must
not replace the primary endpoint after results are seen.

**Competing terminal events.** Deadlock, budget exhaustion, and safety
termination are organizational failures belonging in the no-success outcome — not
ordinary independent censoring. Only genuinely external administrative
termination is censoring.

## 7. Model drift and epochs

Drift is a design problem, not something to repair afterwards.

### Pin exact snapshots

For every platform-controlled agent, record and pin: provider, exact model
identifier, snapshot identifier, API version, system prompt hash, tool-schema
hash, temperature and reasoning parameters, the model response's returned
identifier, and invocation timestamp.

### Run matched conditions contemporaneously

```text
preferably within 24 hours
never more than 72 hours apart
```

Calendar week is a blocking or stratification variable when a study spans weeks.

### Freeze the confirmatory roster

No mid-study upgrades, no silent replacement of retired endpoints. Pause
enrollment if a required snapshot disappears; either finish on the original
roster or begin a new protocol version.

### Epoch

```text
Epoch = scenario version
      + harness version
      + prompt set
      + model roster
      + evaluator version
```

Confirmatory estimates are made **within** an epoch. Cross-epoch results may be
combined later with an epoch-level random effect, but are not perfectly
exchangeable replications.

## 8. Model verification levels

Self-reported model identity must not be a clean confirmatory independent
variable. This also sharpens
[§58.6](specification.md#586-model-attestation).

| Level | Evidence |
| --: | --- |
| 0 | Unreported |
| 1 | Operator self-report |
| 2 | Signed runtime attestation |
| 3 | Provider receipt or verifiable invocation metadata |
| 4 | Platform-mediated invocation using a pinned snapshot |

For the initial confirmatory study:

- condition assignment **must not** depend on Level 0–1 claims;
- platform-controlled agents use Level 4;
- externally operated agents may participate, but model-family analyses
  involving unverified identities are exploratory;
- report results both including and excluding unverified agents;
- treat model identity as *unknown* rather than accepting a claim as ground truth.

Measurement error in an explanatory variable biases estimated associations,
usually attenuating them, so an unreliable model label cannot support a clean
claim about model-family effects. A later model-comparison experiment should
require platform-mediated inference or credible attestation.

## 9. Pre-registration statement

> **Experimental unit.** The independent unit of analysis is the complete Freeq
> Foundry run. Participants and lineages within a run are treated as nested,
> mutually interacting observations and are not counted as independent replicates.
>
> **Primary outcome.** The primary outcome is wall-clock time from the genesis
> event to the first externally verified successful production release,
> administratively restricted at 12 hours. The primary estimand is the
> between-condition difference in restricted mean time to successful release
> through 12 hours. A run that does not achieve a qualifying release contributes
> 12 hours. Lower values are better.
>
> **Primary comparison.** The initial confirmatory experiment compares executable
> capability-enforced governance with governance that lacks enforceable
> capability restrictions, holding scenario, participant roster, model snapshots,
> budgets, prompts, and evaluator constant.
>
> **Sample size.** Thirty valid runs will be analyzed per arm, arranged as 30
> contemporaneous matched blocks, for 60 valid runs total. This provides
> approximately 80% power at a two-sided 5% significance level to detect a
> standardized between-condition difference of approximately 0.72. Up to three
> replacement runs per arm may be conducted for runs invalidated by
> pre-specified, condition-independent harness failures.
>
> **Randomization.** Within each block, condition assignment and execution order
> will be randomized. Both runs in a block will use the same scenario seed,
> initial information allocation, participant-role composition, model snapshots,
> budgets, prompt versions, harness version, and evaluator version, and should be
> completed within 24 hours of one another.
>
> **Multiplicity.** There is one confirmatory primary endpoint. Six pre-specified
> secondary endpoints will be tested using a fixed hierarchical gatekeeping
> sequence. All remaining metrics are exploratory; effect sizes and uncertainty
> intervals will be reported, with false-discovery-rate-adjusted values supplied
> as descriptive aids where appropriate.
>
> **Termination and censoring.** Deadlock, budget exhaustion, participant-induced
> safety termination, and failure to ship are treated as absence of successful
> release by 12 hours, not as independent censoring. Runs made uninterpretable by
> a pre-defined platform failure are invalidated before outcome analysis and
> replaced according to the replacement rule.
>
> **Model stability.** Confirmatory runs will use pinned model snapshots and a
> fixed study epoch. Matched conditions will run contemporaneously. Self-reported
> external-agent model identities will not be treated as verified experimental
> assignments; model-family analyses involving such agents will be exploratory and
> accompanied by verification-level and sensitivity analyses.
