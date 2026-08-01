# Implementation Status

Where the code is against the [specification](specification.md), honestly. Kept
here rather than in the README so it can be detailed without burying the intro.

**Last updated:** 2026-02-19 · 784 tests · [CI](https://github.com/chad/freeq-foundry/actions)

## What works end to end

`pnpm serve` runs a scenario with a live observer at `:7777`;
[docs/running.md](running.md) is the operating guide. `pnpm demo` executes the same run
headless. Either one: a population is admitted, proposes a
capability grant, votes, executes it, does work under that authority, and ships to
an evaluator it cannot influence. The run writes a signed `events.ndjson`, a
manifest, computed metrics, and an evidence-backed report.

Every event is signed twice ([ADR-0008](adr/0008-event-authorship.md)), the chain
verifies, and every projection rebuilds from the log alone — so
[§6.9](specification.md#69-replay-invariant) holds in practice and not just in
principle.

The [§49.6](specification.md#496-condition-f-unenforced-governance) contrast runs
today. With a saboteur present, the enforced arm needs 16 ticks and 7 proposals;
the unenforced arm needs 5 and 1. Enforcement has a measurable cost. Whether it
buys anything is what the secondary metrics are for, and answering it needs
[60 valid runs](research-protocol.md#3-sample-size-30-valid-runs-per-arm) rather
than two.

## Milestones

| # | Milestone | Status |
| --- | --- | --- |
| 1 | Canonical protocol | **Complete** |
| 2 | Identity and provenance | **Complete** except `did:web` and stronger human verification |
| 3 | Well-known onboarding | **Complete** — discovery, negotiation, diagnostics; no external submission yet |
| 4 | Governance core | **Complete** for the run loop; offices, sanctions, appeals remain |
| 5 | Offices, elections, delegation | Partial — election methods and delegation work; offices do not |
| 6 | Treasury and budgets | Partial — credits work; USD metering needs M7 |
| 7 | Agent runtime | **Complete** — OpenAI, Anthropic, Kimi, Ollama, llama.cpp, deterministic, replay |
| 8 | Software tools | **Complete** — real repository, sandbox, CI, capability-gated merge |
| 9 | Deployment and evaluation | Partial — evaluator is external and signs; no real deployment |
| 10 | Observer and reporting | **Complete** — live observer, evidence-backed reports |
| 11 | Private alpha | Not started |
| 12 | Public challenge | Not started |

## Packages

| Package | Tests | State |
| --- | --: | --- |
| [protocol](../packages/protocol) | 224 | Complete. Zero runtime dependencies, published conformance vectors |
| [identity](../packages/identity) | 61 | Nine-condition provenance verification, revocation, admission |
| [model-adapters](../packages/model-adapters) | 41 | Five providers, structured parsing, failover, replay |
| [repository](../packages/repository) | 28 | Commit provenance, three-way merge, capability-gated merge |
| [sandbox](../packages/sandbox) | 24 | Process isolation, limits, secret scanning |
| [evaluation](../packages/evaluation) | 17 | Protected tests, signed verdicts |
| [server](../packages/server) | 21 | Gateway API, well-known, live observer |
| [policy](../packages/policy) | 51 | Complete. `freeq-rules-v1` with decidable attenuation |
| [projections](../packages/projections) | 43 | Eight core projections and derived metrics |
| [event-store](../packages/event-store) | 80 | In-memory and SQLite backends, one shared suite |
| [gateway](../packages/gateway) | 35 | Admission, idempotent ack, visibility filtering |
| [capabilities](../packages/capabilities) | 27 | Complete |
| [governance](../packages/governance) | 41 | Proposals, quorum, elections, execution |
| [agents](../packages/agents) | 20 | Deterministic archetypes only |
| [observability](../packages/observability) | 26 | Metrics and reports; no UI |
| [controller](../packages/controller) | 23 | Runs to termination |

## Honest gaps

Ordered by how much they matter for a real run.

### 1. No real software production

Work items are abstract identifiers. There is no repository, no CI, no sandbox, so
[§59.7](specification.md#59-final-design-principles) — assume generated code is
dangerous — is not yet tested by anything. The evaluator verifies that work items
were marked complete, not that software works.

### 2. No provider adapters

Every agent is deterministic. This validates the harness and costs nothing, but it
means **nothing here says anything about model behaviour**. Model diversity is
currently a slogan rather than the variable [§59.18](specification.md#59-final-design-principles)
requires.

### 3. No durable storage or network transport

The event store is in-memory and the gateway is in-process. A run cannot outlive
the process, and no external operator can connect. Both are designed
([ADR-0006](adr/0006-event-store-backend.md)) and neither is built.

### 4. No study-level budget ceiling

[§21](specification.md#21-treasury-budgets-and-scarcity)'s hard ceiling is
per-run. A confirmatory study needs 60 valid runs — 720 run-hours per contrast —
and nothing prevents a study from overspending while every individual run respects
its ceiling. Flagged in [ADR-0009](adr/0009-research-protocol-harness-requirements.md).

### 6. Pilot variance is unknown

The [research protocol](research-protocol.md)'s power calculation assumes a
between-run standard deviation of roughly 3 hours for the primary outcome. Real
pilots must produce an estimate before enrollment; a materially different value
changes the required *n*.

## What the tests do and do not establish

**Do:** the protocol is correct and cross-implementable; the log is tamper-evident;
projections rebuild exactly; provenance is verified against all nine
[§11.4](specification.md#114-provenance-proof) conditions rather than asserted;
revoking a root suspends its descendants without erasing history; capability
enforcement is load-bearing; governance changes real authority; a run terminates
and records why; one operator's agents are one lineage and cannot pass a proposal
alone.

**Do not:** support any claim about *which* model behaves how — a deterministic run has
no model in it, and a model-backed run is a single anecdote. Nor do they say anything
about how genuinely independent operators behave, since none have connected yet, or
anything that would survive [§58.13](specification.md#5813-research-rigor)'s standard
for a causal claim.

The distinction matters. This is a working harness with a demonstrable experiment,
not a result.
