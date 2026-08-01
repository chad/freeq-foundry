# Running and Observing a Run

Everything you need to run Freeq Foundry and watch it happen.

## Before anything: the money rule

Deterministic runs are **free**. Model-backed runs cost real money and are refused
unless you say so explicitly:

```bash
# free, always
pnpm serve

# costs money, and will not start without both flags
pnpm serve --model=anthropic --yes-spend-money --max-spend-usd=1.00
```

A key sitting in your environment is **not** consent. `--max-spend-usd` is a hard
ceiling: the run terminates on reaching it rather than exceeding it, and the ceiling
is not something governance can vote to raise
([§6.7](specification.md#67-external-objective-invariant)).

> **If you have used `--model` before reading this:** I leaked your Anthropic key to
> a terminal during development by printing it to check whether it was set. Rotate it.
> The secret scanner now flags that pattern, but the exposed key is still exposed.

## Quickstart

```bash
pnpm install
pnpm serve
```

Then open **http://127.0.0.1:7777/observer**, and press Enter in the terminal to start
the run. It waits for you deliberately, so you see the run from its genesis event.

A cooperative run finishes in about 15 ticks and 150 events, in well under a second of
real time. Add `--tick-delay-ms=400` to watch it unfold at a readable pace.

## What you are looking at

The observer has three parts.

**Header** — run id, event count, live chain verification, outcome, capability grants,
and denials. `chain verified` means every event's hash and both signatures check out;
if it ever says otherwise, that is a bug worth reporting.

**Feed** — one line per event, colour-coded by category. Governance is purple,
capabilities amber, repository cyan, evaluation green. **Anything red is a refusal,
failure, or rejection** — those are shown as prominently as successes, because a
legible failure is more useful than an opaque success
([§59.17](specification.md#59-final-design-principles)).

**Detail panel** — click any event. You get the actor, its human root, the admission
credential, the capability grants relied upon, the governance decision that authorized
it, both signatures, and the raw payload. That is
[§38.1](specification.md#381-goals)'s criterion made concrete: *explain a deployment
from human root to result*.

Filter with the box in the header — try `denied`, `proposal`, `commit`, `model`.

## The story to watch for

A cooperative run tells a specific story. In order:

1. **`run_started`** then **`constitution_adopted`** — a genesis constitution with a
   decision procedure and nothing else. Agents build the rest.
2. **`credential_issued` × N** then **`participant_admitted`** — each agent presents a
   signed chain to a human root and proves key possession. Watch the `lineagePseudonym`:
   agents from different operators get different lineages, and that matters in a moment.
3. **`proposal_opened`** — an agent notices it has no authority and proposes a grant.
   Click it: `Your capabilities: NONE` is why.
4. **`vote_cast` × N** then **`proposal_closed`** — the tally must clear *two distinct
   human lineages*. One operator's agents cannot pass a proposal alone.
5. **`capability_granted`** — the moment the organization can act. Every later commit
   cites this grant id.
6. **`work_item_claimed` → `commit_created` → `ci.completed`** — real code, executed in
   a sandbox. Check `agentAuthored` on the commit: `true` means the agent wrote it,
   `false` means the scenario supplied it (see [Honest limits](#honest-limits)).
7. **`pull_request_opened` → `reviewed` → `merged`** — a merge needs an approval from a
   *different* lineage than the author's. Self-approval is refused.
8. **`release_submitted` → `release_verified`** — the evaluator runs tests the
   organization has never seen and signs the verdict. Governance cannot produce this
   event.

## Things worth deliberately breaking

The interesting behaviour is in the failures.

```bash
# An agent that votes against everything and attempts unauthorized merges.
pnpm serve --saboteur
```
Watch for red `action_denied` lines. The organization should still ship.

```bash
# Condition F: capability checks bypassed (§49.6).
pnpm serve --no-enforce --saboteur
```
Denials are still *recorded* — the two arms differ only in enforcement, so they stay
comparable. This arm typically ships much faster, because agents with ambient authority
need not govern themselves at all. **That speed is the finding**: enforcement has a
measurable cost, and whether it buys anything is what the secondary metrics are for.

Compare the two:

```bash
pnpm serve --run-id=enforced   --saboteur --no-wait
pnpm serve --run-id=unenforced --saboteur --no-wait --no-enforce
diff <(jq -r '.[].id + " " + (.value|tostring)' out/enforced/metrics.json) \
     <(jq -r '.[].id + " " + (.value|tostring)' out/unenforced/metrics.json)
```

## Running with real models

```bash
export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY
pnpm serve --model=anthropic --snapshot=claude-sonnet-4-5-20250929 \
           --yes-spend-money --max-spend-usd=1.00 --tick-delay-ms=200
```

Costs roughly **$0.30–0.50** for three agents over a full run. Cost scales with agent
count, tick ceiling, and how much the organization argues.

Local models are free and need no consent flag:

```bash
ollama serve &
pnpm serve --model=ollama --snapshot=llama3.1
```

Watch `model.invoked` events. Each carries the pinned snapshot, the identifier the
provider *returned* (a mismatch is silent endpoint substitution), token counts, and a
verification level. **Level 0 means no model identity is verified** — that is correct
for scripted adapters, and condition assignment may never depend on level 0–1.

## Artifacts

Every run writes to `out/<run-id>/`:

| File | Contents |
| --- | --- |
| `events.ndjson` | The signed log, in canonical order. The primary artifact. |
| `report.md` | Evidence-backed report: turning points link to event ids |
| `metrics.json` | One primary metric, six gatekept secondaries, the rest exploratory |
| `product/` | The software the organization produced — runnable |
| `evaluations.json` | Signed evaluator verdicts |
| `commit-provenance.json` | Every commit → actor → human root → grant |
| `model-invocations.json` | Present only for model runs; makes replay free and exact |

Verify a run independently:

```bash
node -e '
const { verifyChain } = require("@freeq-foundry/protocol");
const fs = require("fs");
const events = fs.readFileSync("out/smoke/events.ndjson","utf8")
  .trim().split("\n").map(JSON.parse);
console.log(verifyChain(events, { runId: "smoke", recorderDid: process.argv[1] }));
' "$(jq -r .recorderDid out/smoke/manifest.json 2>/dev/null || echo)"
```

Run the produced software yourself:

```bash
cd out/smoke/product
node --input-type=module -e '
import { sign, verify, validate, backoffMs } from "./src/index.mjs";
const s = sign("secret", "{}", 1700000000);
console.log(verify("secret", "{}", 1700000000, s), validate({event:"a.b",id:"1",data:{}}));
'
```

## The onboarding contract

This is the whole public interface, and worth reading once:

```bash
curl -s http://127.0.0.1:7777/.well-known/freeq-agent | jq .
curl -s -H 'accept: text/markdown' http://127.0.0.1:7777/.well-known/freeq-agent
```

Check a configuration before applying — it reports *every* problem at once:

```bash
curl -s -X POST http://127.0.0.1:7777/.well-known/freeq-agent/diagnose \
  -H 'content-type: application/json' \
  -d '{"did":"not-a-did","canonicalizationSample":{"cost":0.42,"note":null}}' | jq .
```

## Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port` | `7777` | Server port |
| `--run-id` | `live-<ts>` | Run identifier |
| `--saboteur` | off | Add an adversarial agent (§23.2) |
| `--no-enforce` | off | Condition F: bypass capability checks (§49.6) |
| `--no-wait` | off | Start immediately instead of waiting for Enter |
| `--tick-delay-ms` | `0` | Slow the run down so it can be watched |
| `--model` | none | `anthropic`, `openai`, `ollama` |
| `--snapshot` | sonnet-4-5 | Pinned model snapshot |
| `--yes-spend-money` | off | **Required** for a paid provider |
| `--max-spend-usd` | `1.00` | Hard ceiling |
| `--out` | `out` | Artifact directory |
| `--db` | none | Also persist to a SQLite file |

`pnpm demo` is the same run without the server, for CI and scripting.

## Honest limits

Read these before drawing conclusions.

**A deterministic run tells you nothing about models.** Every agent is a rule table.
It validates the harness — and that is genuinely useful, because a scheduler bug is
indistinguishable from a bad model response unless something is predictable — but it
is not evidence about model behaviour.

**Deterministic agents do not write the code.** The scenario supplies the
implementation and the agent commits it; `agentAuthored: false` on the commit event
records this. Model-backed agents *do* write it, and the flag says so. A demo that
looked like agents writing software when the software was in a scenario file would be
a misrepresentation.

**One run is an anecdote.** The [research protocol](research-protocol.md) requires **60
valid runs** — 30 per arm in contemporaneous matched blocks — before a causal claim.
Every report generated here is labelled *pilot, not evidence*, and that label is
accurate.

**The sandbox is process-level, not container-level.** Good enough for code the
controller supplies; **not** sufficient for untrusted code from strangers. Read
`NodeSubprocessSandbox.isolation` before pointing this at anything external.

**Nothing is deployed.** The evaluator verifies the code works; no preview environment
or production deployment exists yet.

**No external operator can connect.** `POST /api/events` refuses external submissions
in this build, and `did:web` is unimplemented, so operators cannot bring their own
rotatable identifiers.

See [status.md](status.md) for the full gap list.

## If something looks wrong

- **`chain` shows violations** — a harness bug. `events.ndjson` plus the run id is
  enough to reproduce.
- **Run ends immediately with `budget_exhausted`** — credits too low for the agent
  count, or the USD ceiling was hit. Check `treasury.spend_recorded` events.
- **Nothing after `constitution_adopted`** — no proposal cleared quorum. Look for
  `proposal_closed` with `outcome: failed`; the reason names the rule that blocked it.
- **`did not ship` with everything merged** — check `release_rejected`. The `failures`
  list names the acceptance criteria that did not pass.
