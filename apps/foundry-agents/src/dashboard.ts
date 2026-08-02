/**
 * The run dashboard.
 *
 * A single self-contained HTML file built from a signed event log: no CDN, no fonts, no
 * scripts fetched from anywhere. A research artifact that needs the network to render is
 * one that stops rendering, and this is meant to be attachable to a write-up years from
 * now.
 *
 * It answers the questions the channel cannot. A transcript shows you what was said; it
 * does not show you that two agents voted together nineteen times out of twenty, that
 * the cheapest model in the room opened the most proposals, or that the company's
 * equity ended up more concentrated than the run before it. Those are properties of the
 * whole run, and they only exist once someone computes them.
 *
 * Everything here derives from the log alone, so a dashboard can be produced by anyone
 * holding a copy — including a participant who wants to check the referee's arithmetic.
 */
import { verifyChain, type RecordedEvent } from "@freeq-foundry/protocol";
import { summarize, type RunSummary } from "./research.js";

interface TimelineEntry {
  readonly at: number;
  readonly kind: string;
  readonly text: string;
}

interface VotePair {
  readonly a: string;
  readonly b: string;
  readonly together: number;
  readonly total: number;
}

/** Pairwise voting agreement — the cheapest available measure of a faction. */
function coalitions(events: readonly RecordedEvent[], nickOf: (did: string) => string): VotePair[] {
  const byProposal = new Map<string, Map<string, string>>();
  for (const event of events) {
    if (event.eventType !== "governance.vote_cast") continue;
    const p = event.payload as Record<string, unknown>;
    const voter = String(p["voterDid"] ?? p["voter"] ?? "");
    const id = String(p["proposalId"] ?? "");
    if (voter === "" || id === "" || event.actorDid !== voter) continue;
    const votes = byProposal.get(id) ?? new Map<string, string>();
    votes.set(voter, String(p["choice"] ?? "abstain"));
    byProposal.set(id, votes);
  }

  const pairs = new Map<string, { together: number; total: number }>();
  for (const votes of byProposal.values()) {
    const entries = [...votes.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [didA, choiceA] = entries[i] as [string, string];
        const [didB, choiceB] = entries[j] as [string, string];
        const key = `${didA}|${didB}`;
        const cell = pairs.get(key) ?? { together: 0, total: 0 };
        cell.total++;
        if (choiceA === choiceB) cell.together++;
        pairs.set(key, cell);
      }
    }
  }

  return [...pairs.entries()]
    .map(([key, cell]) => {
      const [a, b] = key.split("|") as [string, string];
      return { a: nickOf(a), b: nickOf(b), together: cell.together, total: cell.total };
    })
    // Three shared votes is the floor for saying anything at all; below that the rate is
    // noise dressed up as a finding.
    .filter((pair) => pair.total >= 3)
    .sort((x, y) => y.together / y.total - x.together / x.total);
}

function timeline(events: readonly RecordedEvent[], nickOf: (did: string) => string): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const add = (at: number, kind: string, text: string): void => void out.push({ at, kind, text });

  for (const event of events) {
    const p = event.payload as Record<string, unknown>;
    const at = Date.parse(event.wallTime);
    switch (event.eventType) {
      case "admission.participant_admitted":
        if (typeof p["nick"] === "string") {
          add(at, "join", `@${p["nick"]} admitted (${String(p["provider"] ?? "?")}:${String(p["snapshot"] ?? "?")})`);
        }
        break;
      case "admission.expertise_declared":
        add(at, "declare", `@${nickOf(String(p["did"] ?? event.actorDid))} declared ${(p["expertise"] as string[] | undefined)?.join(", ") ?? ""}`);
        break;
      case "admission.organization_created":
        add(at, "charter", `${String(p["name"])} incorporated`);
        break;
      case "deployment.authority_acquired":
        if (typeof p["office"] === "string") {
          add(at, "office", `${p["office"]} → @${nickOf(String(p["did"]))}`);
        } else if (typeof p["shares"] === "number") {
          add(at, "equity", `${Number(p["shares"]).toLocaleString()} shares → @${nickOf(String(p["did"]))}`);
        }
        break;
      case "deployment.budget_allocated":
        if (typeof p["salary"] === "number") {
          add(at, "money", `@${nickOf(String(p["did"]))} salary $${Number(p["salary"]).toLocaleString()}/wk`);
        }
        break;
      case "capability.granted":
        if (typeof p["toDid"] === "string") {
          add(at, "grant", `@${nickOf(String(p["toDid"]))} granted ${String(p["namespace"])}`);
        }
        break;
      case "repository.commit_created":
        add(at, "code", `${String(p["path"])} (${Number(p["bytes"] ?? 0).toLocaleString()} bytes) by @${nickOf(String(p["authorDid"] ?? event.actorDid))}`);
        break;
      case "ci.completed":
        add(at, "ci", `tests ${String(p["outcome"] ?? "?")}${p["claimMatched"] === false ? " — CLAIM DID NOT MATCH" : ""}`);
        break;
      case "work.completed":
        if (typeof p["valuation"] === "number") add(at, "ship", `work ${String(p["workId"])} accepted · valuation $${Number(p["valuation"]).toLocaleString()}`);
        break;
      case "governance.proposal_closed":
        add(at, String(p["outcome"] ?? "closed"), `${String(p["proposalId"])} ${String(p["outcome"])}${p["reason"] === undefined ? "" : ` — ${String(p["reason"]).slice(0, 60)}`}`);
        break;
      case "admission.participant_refused":
        add(at, "refused", `@${String(p["nick"])} refused: ${String(p["reason"])}`);
        break;
      default:
        break;
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const esc = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

function bar(pct: number, colour: string): string {
  const width = Math.max(0, Math.min(100, pct * 100));
  return `<div class="bar"><span style="width:${width.toFixed(1)}%;background:${colour}"></span></div>`;
}

export function renderDashboard(events: readonly RecordedEvent[]): string {
  const summary: RunSummary = summarize(events);
  const verification = verifyChain(events, { runId: summary.runId });
  const nicks = new Map<string, string>();
  for (const event of events) {
    const p = event.payload as Record<string, unknown>;
    if (event.eventType === "admission.participant_admitted" && typeof p["nick"] === "string") {
      nicks.set(String(p["did"] ?? event.actorDid), p["nick"]);
    }
  }
  const nickOf = (did: string): string => nicks.get(did) ?? `${did.slice(0, 10)}…`;

  const expertise = new Map<string, string[]>();
  const reasoning: { nick: string; text: string; at: string }[] = [];
  const dms: { from: string; to: string; text: string }[] = [];
  for (const event of events) {
    const p = event.payload as Record<string, unknown>;
    if (event.eventType === "admission.expertise_declared") {
      const did = String(p["did"] ?? event.actorDid);
      if (Array.isArray(p["expertise"])) expertise.set(did, (p["expertise"] as string[]).map(String));
    }
    // post_run_reveal: hidden from rivals during the game, disclosed here. The dashboard
    // is the reveal mechanism, which is why it is worth generating even for a run you
    // watched live.
    if (event.eventType === "agent.reasoning") {
      reasoning.push({ nick: nickOf(event.actorDid), text: String(p["reasoning"] ?? ""), at: event.wallTime });
    }
    if (event.eventType === "communication.direct_message") {
      dms.push({ from: nickOf(event.actorDid), to: String(p["to"] ?? "?"), text: String(p["text"] ?? "") });
    }
  }

  const pairs = coalitions(events, nickOf);
  const events_ = timeline(events, nickOf);
  const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;
  const palette = ["#6ea8fe", "#79dfc1", "#ffda6a", "#ea868f", "#c29ffa", "#8ed6f0", "#f6a96b", "#a3cfbb", "#e6a1c9", "#9ec5fe", "#d8b4a0", "#b8c0c8"];

  const metric = (label: string, value: string, note = ""): string =>
    `<div class="metric"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${note === "" ? "" : `<div class="note">${esc(note)}</div>`}</div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(summary.runId)} — Foundry Arena</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--line:#30363d;--text:#e6edf3;--dim:#8b949e;--ok:#3fb950;--bad:#f85149;--accent:#6ea8fe}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:26px;margin:0 0 4px} h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:36px 0 12px;font-weight:600}
.sub{color:var(--dim);margin-bottom:18px}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
.ok{background:rgba(63,185,80,.15);color:var(--ok);border:1px solid rgba(63,185,80,.4)}
.bad{background:rgba(248,81,73,.15);color:var(--bad);border:1px solid rgba(248,81,73,.4)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.metric{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}
.metric .label{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.metric .value{font-size:22px;font-weight:600;margin-top:4px}
.metric .note{color:var(--dim);font-size:12px;margin-top:2px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);padding:10px;border-bottom:1px solid var(--line)}
td{padding:9px 10px;border-bottom:1px solid rgba(48,54,61,.5);vertical-align:middle}
tr:last-child td{border-bottom:none}
.bar{background:rgba(255,255,255,.06);border-radius:3px;height:8px;width:100%;overflow:hidden}
.bar span{display:block;height:100%;border-radius:3px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.dim{color:var(--dim)}
.tl{border-left:2px solid var(--line);margin-left:8px;padding-left:16px}
.tl .row{position:relative;padding:5px 0;font-size:13px}
.tl .row::before{content:"";position:absolute;left:-21px;top:11px;width:8px;height:8px;border-radius:50%;background:var(--accent)}
.tl .row.charter::before,.tl .row.ship::before{background:var(--ok)}
.tl .row.failed::before,.tl .row.refused::before{background:var(--bad)}
.tl .row.code::before{background:#c29ffa}
.tag{display:inline-block;background:rgba(110,168,254,.12);color:var(--accent);border-radius:4px;padding:1px 6px;font-size:11px;margin-right:4px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px;margin-bottom:10px}
.q{color:var(--dim);font-style:italic}
footer{margin-top:48px;color:var(--dim);font-size:12px;border-top:1px solid var(--line);padding-top:16px}
</style></head><body><div class="wrap">

<h1>${esc(summary.companyName ?? "No company was formed")}</h1>
<div class="sub">${esc(summary.product ?? "no product chosen")} · run <span class="mono">${esc(summary.runId)}</span></div>
<span class="badge ${verification.valid ? "ok" : "bad"}">${verification.valid ? "chain verified" : `chain INVALID · ${verification.violations.length} violations`}</span>

<h2>Outcome</h2>
<div class="grid">
${metric("Events", String(summary.events), `${Math.round(summary.durationSecs)}s`)}
${metric("Equity Gini", summary.equityGini.toFixed(3), summary.equityGini < 0.2 ? "near-equal split" : summary.equityGini > 0.55 ? "concentrated" : "mixed")}
${metric("Top holder", `${(summary.topHolderPct * 100).toFixed(1)}%`)}
${metric("Offices", String(summary.officesFilled), "invented by the group")}
${metric("Proposals", String(summary.proposalsOpened), `${summary.proposalsPassed} passed · ${summary.proposalsFailed} failed`)}
${metric("Votes", String(summary.votesCast))}
${metric("Work shipped", String(summary.workCompleted))}
${metric("Model spend", usd(summary.costMicros), "real money")}
</div>

<h2>Cap table</h2>
<table><tr><th>founder</th><th>model</th><th>declared expertise</th><th style="width:150px">equity</th><th>office</th><th>salary</th><th>spend</th></tr>
${summary.participants.map((p, i) => `<tr>
<td><strong>${esc(p.nick)}</strong></td>
<td class="mono dim">${esc(p.provider)}:${esc(p.snapshot)}</td>
<td>${(expertise.get(p.did) ?? []).map((e) => `<span class="tag">${esc(e)}</span>`).join("") || '<span class="dim">none</span>'}</td>
<td>${bar(p.sharePct, palette[i % palette.length] as string)}<span class="dim mono">${(p.sharePct * 100).toFixed(1)}%</span></td>
<td>${p.offices.length === 0 ? '<span class="dim">—</span>' : esc(p.offices.join(", "))}</td>
<td class="mono">${p.salary === 0 ? '<span class="dim">—</span>' : `$${p.salary.toLocaleString()}`}</td>
<td class="mono dim">${usd(p.costMicros)}</td></tr>`).join("")}
</table>

<h2>Participation</h2>
<table><tr><th>founder</th><th>proposals opened</th><th>votes cast</th><th>tool calls</th><th>refusals</th><th>model calls</th></tr>
${summary.participants.map((p) => `<tr><td><strong>${esc(p.nick)}</strong></td>
<td>${p.proposalsOpened}</td><td>${p.votesCast}</td><td>${p.toolCalls}</td>
<td>${p.refusals > 0 ? `<span style="color:var(--bad)">${p.refusals}</span>` : "0"}</td>
<td class="dim">${p.modelCalls}</td></tr>`).join("")}
</table>

${pairs.length === 0 ? "" : `<h2>Voting blocs</h2>
<div class="sub dim">Pairwise agreement over shared votes. Nobody was told to form a faction; these are whatever emerged.</div>
<table><tr><th>pair</th><th style="width:220px">agreement</th><th>shared votes</th></tr>
${pairs.slice(0, 12).map((pair) => `<tr><td>@${esc(pair.a)} &amp; @${esc(pair.b)}</td>
<td>${bar(pair.together / pair.total, pair.together / pair.total > 0.8 ? "#3fb950" : pair.together / pair.total < 0.4 ? "#f85149" : "#ffda6a")}<span class="mono dim">${((pair.together / pair.total) * 100).toFixed(0)}%</span></td>
<td class="dim">${pair.together}/${pair.total}</td></tr>`).join("")}
</table>`}

<h2>Timeline</h2>
<div class="tl">
${events_.map((e) => `<div class="row ${esc(e.kind)}"><span class="tag">${esc(e.kind)}</span>${esc(e.text)}</div>`).join("")}
</div>

${dms.length === 0 ? "" : `<h2>Private messages (revealed)</h2>
<div class="sub dim">Invisible to everyone but sender and recipient during the run.</div>
${dms.slice(0, 40).map((d) => `<div class="card"><strong>@${esc(d.from)} → @${esc(d.to)}</strong><div class="q">${esc(d.text)}</div></div>`).join("")}`}

${reasoning.length === 0 ? "" : `<h2>Private reasoning (revealed)</h2>
<div class="sub dim">Recorded under post-run-reveal visibility: no rival could read these while the game was live. ${reasoning.length} entries; most recent 40 shown.</div>
${reasoning.slice(-40).map((r) => `<div class="card"><strong>@${esc(r.nick)}</strong> <span class="dim mono">${esc(r.at.slice(11, 19))}</span><div class="q">${esc(r.text)}</div></div>`).join("")}`}

<footer>
Generated from ${summary.events} signed events · ${verification.valid ? "hash chain verified" : `${verification.violations.length} chain violations`} ·
every figure here is recomputable from the log with <span class="mono">foundry-agent report</span>.
</footer>
</div></body></html>`;
}
