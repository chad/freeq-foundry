/**
 * The researcher's view of a run.
 *
 * Everything interesting found so far — that identical rosters under identical rules
 * produced an oligarchy in one session and an equal split twelve ways in another — was
 * extracted by hand with throwaway scripts. That is fine once. It is not a research
 * platform.
 *
 * This module answers the questions a person actually has after a run, from the signed
 * log alone:
 *
 *   - What institution emerged? Who holds equity, who holds office, who got paid?
 *   - How concentrated is the outcome? (Gini and the top holder's share.)
 *   - Who talked, who acted, and who merely voted?
 *   - Did any model's behaviour differ systematically from another's?
 *   - What did it cost, and is the record intact?
 *
 * And across runs: the same rules producing different institutions is the finding, so
 * comparison is a first-class operation rather than a spreadsheet exercise.
 */
import { readFileSync } from "node:fs";
import { verifyChain, type RecordedEvent } from "@freeq-foundry/protocol";

export interface ParticipantSummary {
  readonly did: string;
  readonly nick: string;
  readonly provider: string;
  readonly snapshot: string;
  readonly ownerDid: string;
  readonly shares: number;
  readonly sharePct: number;
  readonly offices: readonly string[];
  readonly salary: number;
  readonly proposalsOpened: number;
  readonly votesCast: number;
  readonly messagesPosted: number;
  readonly toolCalls: number;
  readonly refusals: number;
  readonly costMicros: number;
  readonly modelCalls: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly chainValid: boolean;
  readonly chainViolations: number;
  readonly events: number;
  readonly durationSecs: number;
  readonly costMicros: number;
  readonly incorporated: boolean;
  readonly companyName: string | undefined;
  readonly product: string | undefined;
  readonly valuation: number;
  readonly proposalsOpened: number;
  readonly proposalsPassed: number;
  readonly proposalsFailed: number;
  readonly votesCast: number;
  readonly workCompleted: number;
  readonly participants: readonly ParticipantSummary[];
  /** 0 = perfectly equal, 1 = one holder owns everything. */
  readonly equityGini: number;
  readonly topHolderPct: number;
  readonly officesFilled: number;
}

export function loadRun(path: string): readonly RecordedEvent[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as RecordedEvent);
}

/**
 * The Gini coefficient of the cap table.
 *
 * One number for "did this become an oligarchy or a commune", which is the single most
 * useful comparison across runs. Zero holders is defined as zero, not NaN: a company
 * that never incorporated is perfectly equal in the only sense available.
 */
export function gini(values: readonly number[]): number {
  const sorted = [...values].filter((v) => v >= 0).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  const total = sorted.reduce((sum, v) => sum + v, 0);
  if (total === 0) return 0;
  let weighted = 0;
  for (const [i, value] of sorted.entries()) weighted += (i + 1) * value;
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

export function summarize(events: readonly RecordedEvent[]): RunSummary {
  const runId = events[0]?.runId ?? "(empty)";
  const verification = verifyChain(events, { runId });

  const people = new Map<string, {
    nick: string; provider: string; snapshot: string; ownerDid: string;
    shares: number; offices: string[]; salary: number;
    proposalsOpened: number; votesCast: number; messagesPosted: number;
    toolCalls: number; refusals: number; costMicros: number; modelCalls: number;
  }>();
  const ensure = (did: string) => {
    let p = people.get(did);
    if (p === undefined) {
      p = {
        nick: did.slice(-6), provider: "?", snapshot: "?", ownerDid: "?",
        shares: 0, offices: [], salary: 0, proposalsOpened: 0, votesCast: 0,
        messagesPosted: 0, toolCalls: 0, refusals: 0, costMicros: 0, modelCalls: 0,
      };
      people.set(did, p);
    }
    return p;
  };

  let companyName: string | undefined;
  let product: string | undefined;
  let valuation = 0;
  let passed = 0;
  let failed = 0;
  let opened = 0;
  let votes = 0;
  let workCompleted = 0;
  let cost = 0;
  const seenProposals = new Set<string>();

  for (const event of events) {
    const p = event.payload as Record<string, unknown>;
    switch (event.eventType) {
      case "admission.participant_admitted": {
        const person = ensure(String(p["did"] ?? event.actorDid));
        person.nick = String(p["nick"] ?? person.nick);
        person.provider = String(p["provider"] ?? person.provider);
        person.snapshot = String(p["snapshot"] ?? person.snapshot);
        person.ownerDid = String(p["ownerDid"] ?? person.ownerDid);
        break;
      }
      case "admission.organization_created": {
        companyName = String(p["name"] ?? "");
        for (const f of (p["founders"] as { did: string; shares: number }[] | undefined) ?? []) {
          ensure(f.did).shares += Number(f.shares ?? 0);
        }
        break;
      }
      case "governance.proposal_opened":
        // The proposer records one and the registrar records another on acceptance;
        // counting both would double every proposal in the run.
        if (p["acceptedBy"] === "registrar") {
          const id = String(p["proposalId"] ?? "");
          if (!seenProposals.has(id)) {
            seenProposals.add(id);
            opened++;
            const proposer = String(p["proposerDid"] ?? p["proposer"] ?? "");
            if (proposer !== "") ensure(proposer).proposalsOpened++;
          }
        }
        break;
      case "governance.proposal_closed":
        if (p["outcome"] === "passed") passed++;
        else failed++;
        break;
      case "governance.vote_cast": {
        const voter = String(p["voterDid"] ?? p["voter"] ?? "");
        if (voter !== "" && event.actorDid === voter) {
          votes++;
          ensure(voter).votesCast++;
        }
        break;
      }
      case "deployment.authority_acquired": {
        const did = String(p["did"] ?? "");
        if (did === "") break;
        if (typeof p["office"] === "string") {
          // Seating is announced by effect and by log; without the guard an officer
          // shows up as "CPO+CPO".
          const held = ensure(did).offices;
          if (!held.includes(p["office"])) held.push(p["office"]);
        }
        if (typeof p["shares"] === "number") ensure(did).shares += p["shares"];
        break;
      }
      case "deployment.budget_allocated":
        if (typeof p["salary"] === "number" && typeof p["did"] === "string") {
          ensure(p["did"]).salary = p["salary"];
        }
        break;
      case "work.item_claimed":
        if (typeof p["product"] === "string") product = p["product"];
        break;
      case "work.completed":
        workCompleted++;
        if (typeof p["valuation"] === "number") valuation = Math.max(valuation, p["valuation"]);
        break;
      case "model.invoked": {
        const person = ensure(event.actorDid);
        person.modelCalls++;
        const micros = Number(p["costMicros"] ?? 0);
        person.costMicros += micros;
        cost += micros;
        break;
      }
      case "work.tool_executed": {
        const person = ensure(event.actorDid);
        person.toolCalls++;
        if (p["ok"] === false) person.refusals++;
        if (p["tool"] === "post") person.messagesPosted++;
        break;
      }
      default:
        break;
    }
  }

  const times = events.map((e) => Date.parse(e.wallTime)).filter((t) => !Number.isNaN(t));
  const totalShares = [...people.values()].reduce((sum, p) => sum + p.shares, 0);
  const participants: ParticipantSummary[] = [...people.entries()]
    .map(([did, p]) => ({
      did,
      nick: p.nick,
      provider: p.provider,
      snapshot: p.snapshot,
      ownerDid: p.ownerDid,
      shares: p.shares,
      sharePct: totalShares === 0 ? 0 : p.shares / totalShares,
      offices: p.offices,
      salary: p.salary,
      proposalsOpened: p.proposalsOpened,
      votesCast: p.votesCast,
      messagesPosted: p.messagesPosted,
      toolCalls: p.toolCalls,
      refusals: p.refusals,
      costMicros: p.costMicros,
      modelCalls: p.modelCalls,
    }))
    // Registrar and recorder appear as actors but hold nothing; keep them out of the
    // cap table statistics or every run looks like it has a silent partner.
    .filter((p) => p.modelCalls > 0 || p.shares > 0)
    .sort((a, b) => b.shares - a.shares || b.votesCast - a.votesCast);

  return {
    runId,
    chainValid: verification.valid,
    chainViolations: verification.violations.length,
    events: events.length,
    durationSecs: times.length < 2 ? 0 : (Math.max(...times) - Math.min(...times)) / 1000,
    costMicros: cost,
    incorporated: companyName !== undefined,
    companyName,
    product,
    valuation,
    proposalsOpened: opened,
    proposalsPassed: passed,
    proposalsFailed: failed,
    votesCast: votes,
    workCompleted,
    participants,
    equityGini: gini(participants.map((p) => p.shares)),
    topHolderPct: participants[0]?.sharePct ?? 0,
    officesFilled: new Set(participants.flatMap((p) => p.offices)).size,
  };
}

export function renderRun(summary: RunSummary): string {
  const lines: string[] = [];
  const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`;
  lines.push("");
  lines.push(`  ${summary.runId}`);
  lines.push(
    `  ${summary.incorporated ? summary.companyName ?? "(unnamed)" : "never incorporated"}` +
      `${summary.product === undefined ? "" : ` — ${summary.product}`}`,
  );
  lines.push("");
  lines.push(`    chain          ${summary.chainValid ? "verified" : `INVALID (${summary.chainViolations})`}`);
  lines.push(`    events         ${summary.events} over ${Math.round(summary.durationSecs)}s`);
  lines.push(`    proposals      ${summary.proposalsOpened} opened · ${summary.proposalsPassed} passed · ${summary.proposalsFailed} failed`);
  lines.push(`    votes          ${summary.votesCast}`);
  lines.push(`    offices filled ${summary.officesFilled}`);
  lines.push(`    work shipped   ${summary.workCompleted}`);
  lines.push(`    equity gini    ${summary.equityGini.toFixed(3)}  (0 = equal split, 1 = winner takes all)`);
  lines.push(`    top holder     ${(summary.topHolderPct * 100).toFixed(1)}%`);
  lines.push(`    model spend    ${usd(summary.costMicros)}`);
  lines.push("");
  lines.push(
    `    ${"agent".padEnd(12)}${"model".padEnd(34)}${"equity".padStart(8)}${"office".padStart(10)}` +
      `${"props".padStart(7)}${"votes".padStart(7)}${"spend".padStart(10)}`,
  );
  for (const p of summary.participants) {
    lines.push(
      `    ${p.nick.padEnd(12)}${`${p.provider}:${p.snapshot}`.slice(0, 32).padEnd(34)}` +
        `${`${(p.sharePct * 100).toFixed(1)}%`.padStart(8)}${(p.offices.join("+") || "—").padStart(10)}` +
        `${String(p.proposalsOpened).padStart(7)}${String(p.votesCast).padStart(7)}${usd(p.costMicros).padStart(10)}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Compare runs.
 *
 * The headline result of this project is that the same rules and the same roster do not
 * produce the same institution twice, so the comparison table is the finding — not a
 * convenience.
 */
export function renderComparison(summaries: readonly RunSummary[]): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `  ${"run".padEnd(22)}${"company".padEnd(26)}${"gini".padStart(6)}${"top%".padStart(7)}` +
      `${"offices".padStart(9)}${"passed".padStart(8)}${"failed".padStart(8)}${"shipped".padStart(9)}${"cost".padStart(10)}`,
  );
  for (const s of summaries) {
    lines.push(
      `  ${s.runId.slice(0, 20).padEnd(22)}` +
        `${(s.incorporated ? (s.companyName ?? "?").slice(0, 24) : "—").padEnd(26)}` +
        `${s.equityGini.toFixed(2).padStart(6)}${`${(s.topHolderPct * 100).toFixed(0)}%`.padStart(7)}` +
        `${String(s.officesFilled).padStart(9)}${String(s.proposalsPassed).padStart(8)}` +
        `${String(s.proposalsFailed).padStart(8)}${String(s.workCompleted).padStart(9)}` +
        `${`$${(s.costMicros / 1_000_000).toFixed(2)}`.padStart(10)}`,
    );
  }

  const incorporated = summaries.filter((s) => s.incorporated);
  if (incorporated.length > 1) {
    const ginis = incorporated.map((s) => s.equityGini);
    const spread = Math.max(...ginis) - Math.min(...ginis);
    lines.push("");
    lines.push(
      `  ${incorporated.length}/${summaries.length} runs incorporated. Equity concentration ranged ` +
        `${Math.min(...ginis).toFixed(2)}–${Math.max(...ginis).toFixed(2)} (spread ${spread.toFixed(2)}).`,
    );
    if (spread > 0.15) {
      lines.push("  Identical rules produced materially different institutions. That is the result.");
    }
  }
  lines.push("");
  return lines.join("\n");
}
