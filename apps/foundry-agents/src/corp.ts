/**
 * The corporation game.
 *
 * Twelve agents, one channel, one scarce cap table. This module is the rules: a pure
 * projection from accepted proposals and votes into corporate state. The registrar
 * (registrar.ts) feeds it channel events and enforces its verdicts; agents only ever
 * *propose* — nothing an agent says changes the state until the rules say so.
 *
 * ## Why the rules exist at all
 *
 * "Each agent wants maximum compensation and/or influence" is only interesting if both
 * are scarce and neither can be seized unilaterally. So:
 *
 *   - **Equity is finite.** The charter authorizes a fixed share count. Every grant
 *     dilutes everyone. An agent arguing for its own grant is arguing against every
 *     other holder's percentage — which is exactly the argument a human watching wants
 *     to see.
 *   - **Influence is zero-sum.** Five offices, twelve agents. Elections replace the
 *     incumbent, so backing a rival for CEO has a visible cost.
 *   - **Self-dealing needs other people.** Only the CEO can open an equity grant — but
 *     grants pass by majority of *shares*, so a CEO enriching itself must convince the
 *     very holders it is diluting. That is the whole game in one rule.
 *
 * ## What "success" means
 *
 * Valuation is a milestone ladder the registrar climbs (incorporation, first shipped
 * work item). Agents hold virtual equity in it; the scoreboard at the end shows each
 * agent's paper outcome next to the *real* model spend it cost. The contrast is the
 * demo's punchline and is deliberate.
 *
 * This module is deliberately free of I/O, models, and freeq. Rules you cannot test
 * without a network are rules you cannot trust.
 */

export type Office = "CEO" | "CTO" | "CFO" | "CPO" | "CRO";

export const OFFICES: readonly Office[] = ["CEO", "CTO", "CFO", "CPO", "CRO"];

export type ProposalKind =
  | "charter"
  | "charter_amendment"
  | "officer"
  | "equity_grant"
  | "comp"
  | "work_item"
  | "product"
  | "budget";

export interface FounderAllocation {
  readonly did: string;
  readonly shares: number;
}

export interface WorkItem {
  readonly id: string;
  readonly title: string;
  readonly assigneeDid: string;
  readonly openedBy: string;
  readonly status: "open" | "complete";
}

export interface CorpState {
  readonly phase: "unformed" | "incorporated";
  readonly companyName?: string;
  readonly mission?: string;
  /** Authorized shares. Grants may not push issued shares past this without amendment. */
  readonly sharesAuthorized: number;
  /** Issued shares per DID. */
  readonly shares: ReadonlyMap<string, number>;
  readonly officers: ReadonlyMap<Office, string>;
  /** Virtual treasury, in whole virtual dollars. */
  readonly treasury: number;
  /** Weekly virtual salary per DID. */
  readonly comp: ReadonlyMap<string, number>;
  readonly workItems: ReadonlyMap<string, WorkItem>;
  readonly proposals: ReadonlyMap<string, Proposal>;
  readonly productName?: string;
  readonly valuation: number;
  readonly completedWork: number;
}

export interface Proposal {
  readonly id: string;
  readonly kind: ProposalKind;
  readonly title: string;
  readonly rationale: string;
  readonly proposerDid: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly votes: ReadonlyMap<string, "yes" | "no" | "abstain">;
  readonly status: "open" | "passed" | "failed";
}

export type CorpEffect =
  | { readonly type: "charter_ratified"; readonly name: string; readonly founders: readonly FounderAllocation[] }
  | { readonly type: "officer_seated"; readonly office: Office; readonly did: string; readonly replacedDid?: string }
  | { readonly type: "equity_issued"; readonly did: string; readonly shares: number; readonly totalIssued: number }
  | { readonly type: "comp_set"; readonly did: string; readonly salary: number }
  | { readonly type: "work_opened"; readonly id: string; readonly title: string; readonly assigneeDid: string }
  | { readonly type: "work_completed"; readonly id: string; readonly valuation: number }
  | { readonly type: "product_selected"; readonly name: string }
  | { readonly type: "treasury_changed"; readonly delta: number; readonly balance: number }
  | { readonly type: "proposal_passed"; readonly id: string }
  | { readonly type: "proposal_failed"; readonly id: string; readonly reason: string }
  // The registrar turns this into a capability grant event; equity buys tools, not actions.
  | { readonly type: "grant"; readonly did: string; readonly namespace: string };

export const INITIAL_VALUATION = 1_000_000;
export const MVP_VALUATION = 10_000_000;
export const INITIAL_TREASURY = 250_000;

export function initialCorpState(): CorpState {
  return {
    phase: "unformed",
    sharesAuthorized: 0,
    shares: new Map(),
    officers: new Map(),
    treasury: 0,
    comp: new Map(),
    workItems: new Map(),
    proposals: new Map(),
    valuation: 0,
    completedWork: 0,
  };
}

export function totalIssued(state: CorpState): number {
  let total = 0;
  for (const shares of state.shares.values()) total += shares;
  return total;
}

export function sharesOf(state: CorpState, did: string): number {
  return state.shares.get(did) ?? 0;
}

export interface OpenResult {
  readonly ok: boolean;
  readonly reason?: string | undefined;
  readonly state: CorpState;
}

/**
 * Who may open what.
 *
 * A vacant office's powers fall to the CEO; a vacant CEO means anyone may open, so the
 * game can never wedge on an empty seat. Pre-incorporation only `charter` opens at all —
 * the founding argument happens before anything else, which is the order the drama
 * needs.
 */
export function mayOpen(
  state: CorpState,
  kind: ProposalKind,
  proposerDid: string,
  rosterDids: readonly string[],
): { readonly ok: boolean; readonly reason?: string } {
  if (!rosterDids.includes(proposerDid)) {
    return { ok: false, reason: "proposer is not one of the twelve" };
  }

  if (state.phase === "unformed") {
    return kind === "charter"
      ? { ok: true }
      : { ok: false, reason: "the company does not exist yet; ratify a charter first" };
  }
  if (kind === "charter") {
    return { ok: false, reason: "already incorporated; use charter_amendment" };
  }

  /** Power for a kind, with vacancy fallback. */
  const holder = (office: Office): string | undefined =>
    state.officers.get(office) ?? (office === "CEO" ? undefined : state.officers.get("CEO"));

  switch (kind) {
    case "equity_grant": {
      const ceo = state.officers.get("CEO");
      return ceo === undefined || proposerDid === ceo
        ? { ok: true }
        : { ok: false, reason: "only the CEO may open an equity grant" };
    }
    case "comp":
    case "budget": {
      const cfo = holder("CFO");
      return cfo === undefined || proposerDid === cfo
        ? { ok: true }
        : { ok: false, reason: `only the CFO may open ${kind}` };
    }
    case "work_item": {
      const ceo = state.officers.get("CEO");
      const cto = state.officers.get("CTO");
      return proposerDid === ceo || proposerDid === cto || (ceo === undefined && cto === undefined)
        ? { ok: true }
        : { ok: false, reason: "only the CEO or CTO may open work items" };
    }
    case "product": {
      const cpo = holder("CPO");
      return cpo === undefined || proposerDid === cpo
        ? { ok: true }
        : { ok: false, reason: "only the CPO may select the product" };
    }
    default:
      // officer, charter_amendment: anyone may force a vote. Coups are legal.
      return { ok: true };
  }
}

/** Validate the payload of a proposal at open time. */
function validatePayload(
  state: CorpState,
  kind: ProposalKind,
  payload: Readonly<Record<string, unknown>>,
  rosterDids: readonly string[],
): { ok: boolean; reason?: string } {
  switch (kind) {
    case "charter": {
      const founders = payload["founders"];
      const total = payload["sharesAuthorized"];
      if (typeof payload["companyName"] !== "string" || payload["companyName"].trim() === "") {
        return { ok: false, reason: "charter needs a companyName" };
      }
      if (typeof total !== "number" || total <= 0 || total > 100_000_000) {
        return { ok: false, reason: "sharesAuthorized must be between 1 and 100,000,000" };
      }
      if (!Array.isArray(founders)) return { ok: false, reason: "charter needs a founders array" };
      let allocated = 0;
      for (const founder of founders as unknown[]) {
        const f = founder as Record<string, unknown>;
        if (typeof f["did"] !== "string" || !rosterDids.includes(f["did"])) {
          return { ok: false, reason: "every founder must be one of the twelve" };
        }
        if (typeof f["shares"] !== "number" || f["shares"] < 0) {
          return { ok: false, reason: "founder shares must be non-negative numbers" };
        }
        allocated += f["shares"];
      }
      return allocated <= total
        ? { ok: true }
        : { ok: false, reason: `founders allocated ${allocated} but only ${total} authorized` };
    }
    case "charter_amendment": {
      const total = payload["sharesAuthorized"];
      return typeof total === "number" && total >= totalIssued(state)
        ? { ok: true }
        : { ok: false, reason: "amendment must set sharesAuthorized ≥ current issued shares" };
    }
    case "officer": {
      const office = payload["office"];
      const did = payload["did"];
      if (!OFFICES.includes(office as Office)) return { ok: false, reason: `office must be one of ${OFFICES.join(", ")}` };
      return typeof did === "string" && rosterDids.includes(did)
        ? { ok: true }
        : { ok: false, reason: "officer must be one of the twelve" };
    }
    case "equity_grant": {
      const did = payload["did"];
      const shares = payload["shares"];
      if (typeof did !== "string" || !rosterDids.includes(did)) return { ok: false, reason: "grantee must be one of the twelve" };
      if (typeof shares !== "number" || shares <= 0) return { ok: false, reason: "shares must be positive" };
      return totalIssued(state) + shares <= state.sharesAuthorized
        ? { ok: true }
        : { ok: false, reason: `grant exceeds authorized shares; amend the charter first (${state.sharesAuthorized - totalIssued(state)} remaining)` };
    }
    case "comp": {
      const did = payload["did"];
      const salary = payload["salary"];
      if (typeof did !== "string" || !rosterDids.includes(did)) return { ok: false, reason: "payee must be one of the twelve" };
      return typeof salary === "number" && salary >= 0 && salary <= 1_000_000
        ? { ok: true }
        : { ok: false, reason: "salary must be between 0 and 1,000,000 per week" };
    }
    case "work_item": {
      const assignee = payload["assigneeDid"];
      if (typeof payload["title"] !== "string" || payload["title"].trim() === "") return { ok: false, reason: "work item needs a title" };
      return typeof assignee === "string" && rosterDids.includes(assignee)
        ? { ok: true }
        : { ok: false, reason: "assignee must be one of the twelve" };
    }
    case "product":
      return typeof payload["name"] === "string" && payload["name"].trim() !== ""
        ? { ok: true }
        : { ok: false, reason: "product needs a name" };
    case "budget": {
      const delta = payload["delta"];
      if (typeof delta !== "number") return { ok: false, reason: "budget needs a numeric delta" };
      return state.treasury + delta >= 0
        ? { ok: true }
        : { ok: false, reason: `treasury would go negative (${state.treasury} + ${delta})` };
    }
    default:
      return { ok: false, reason: `unknown proposal kind ${String(kind)}` };
  }
}

export function openProposal(
  state: CorpState,
  input: {
    readonly id: string;
    readonly kind: ProposalKind;
    readonly title: string;
    readonly rationale: string;
    readonly proposerDid: string;
    readonly payload: Readonly<Record<string, unknown>>;
  },
  rosterDids: readonly string[],
): OpenResult {
  const allowed = mayOpen(state, input.kind, input.proposerDid, rosterDids);
  if (!allowed.ok) return { ok: false, reason: allowed.reason, state };
  const valid = validatePayload(state, input.kind, input.payload, rosterDids);
  if (!valid.ok) return { ok: false, reason: valid.reason, state };
  if (state.proposals.has(input.id)) return { ok: false, reason: "duplicate proposal id", state };

  const proposal: Proposal = { ...input, votes: new Map(), status: "open" };
  const proposals = new Map(state.proposals);
  proposals.set(input.id, proposal);
  return { ok: true, state: { ...state, proposals } };
}

export interface VoteResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly state: CorpState;
  /** Set when this vote closed the proposal. */
  readonly effects: readonly CorpEffect[];
}

/**
 * Cast a vote and, if it decides the outcome, apply the effects.
 *
 * Thresholds:
 *   - charter: strict majority of the twelve (7 of 12), one DID one vote
 *   - charter_amendment: yes shares ≥ 2/3 of issued
 *   - everything else: yes shares > 1/2 of issued
 *
 * A proposal also fails the moment passage becomes arithmetically impossible, so a
 * doomed charter dies in minutes rather than lingering. Abstentions count as cast:
 * under a majority-of-issued rule, abstaining is voting no with extra steps, and the
 * rules doc says so plainly.
 */
export function castVote(
  state: CorpState,
  proposalId: string,
  voterDid: string,
  choice: "yes" | "no" | "abstain",
  rosterDids: readonly string[],
): VoteResult {
  const proposal = state.proposals.get(proposalId);
  if (proposal === undefined) return { ok: false, reason: `no proposal ${proposalId}`, state, effects: [] };
  if (proposal.status !== "open") return { ok: false, reason: `${proposalId} is already ${proposal.status}`, state, effects: [] };
  if (!rosterDids.includes(voterDid)) return { ok: false, reason: "voter is not one of the twelve", state, effects: [] };

  const votes = new Map(proposal.votes);
  votes.set(voterDid, choice); // changing your mind is legal; only the last vote counts
  const open = { ...proposal, votes };

  if (proposal.kind === "charter") {
    let yes = 0;
    let no = 0;
    for (const vote of votes.values()) {
      if (vote === "yes") yes++;
      else if (vote === "no") no++;
    }
    const total = rosterDids.length;
    const needed = Math.floor(total / 2) + 1;
    if (yes >= needed) return closePassed({ ...state, proposals: replaced(state, open) }, open);
    if (total - no < needed) {
      return closeFailed({ ...state, proposals: replaced(state, open) }, open, "majority of the twelve is unreachable");
    }
    return { ok: true, state: { ...state, proposals: replaced(state, open) }, effects: [] };
  }

  // Share-weighted.
  const issued = totalIssued(state);
  if (issued === 0) return { ok: false, reason: "no shares issued; ratify a charter first", state, effects: [] };

  let yesShares = 0;
  let castShares = 0;
  for (const [did, vote] of votes) {
    const weight = sharesOf(state, did);
    castShares += weight;
    if (vote === "yes") yesShares += weight;
  }

  const passed =
    proposal.kind === "charter_amendment"
      ? yesShares * 3 >= issued * 2
      : yesShares * 2 > issued;
  if (passed) return closePassed({ ...state, proposals: replaced(state, open) }, open);

  const possibleYes = yesShares + (issued - castShares);
  const doomed =
    proposal.kind === "charter_amendment"
      ? possibleYes * 3 < issued * 2
      : possibleYes * 2 <= issued;
  if (doomed) {
    return closeFailed({ ...state, proposals: replaced(state, open) }, open, "required share threshold is unreachable");
  }
  return { ok: true, state: { ...state, proposals: replaced(state, open) }, effects: [] };
}

function replaced(state: CorpState, proposal: Proposal): Map<string, Proposal> {
  const proposals = new Map(state.proposals);
  proposals.set(proposal.id, proposal);
  return proposals;
}

function closePassed(state: CorpState, proposal: Proposal): VoteResult {
  const closed = { ...proposal, status: "passed" as const };
  const proposals = replaced(state, closed);
  const base: CorpState = { ...state, proposals };
  const effects: CorpEffect[] = [{ type: "proposal_passed", id: proposal.id }];
  const p = proposal.payload;

  switch (proposal.kind) {
    case "charter": {
      const founders = (p["founders"] as unknown[]).map((f) => {
        const founder = f as Record<string, unknown>;
        return { did: founder["did"] as string, shares: founder["shares"] as number };
      });
      const shares = new Map<string, number>();
      for (const founder of founders) {
        if (founder.shares > 0) shares.set(founder.did, (shares.get(founder.did) ?? 0) + founder.shares);
      }
      const name = String(p["companyName"]);
      effects.push({ type: "charter_ratified", name, founders });
      return {
        ok: true,
        state: {
          ...base,
          phase: "incorporated",
          companyName: name,
          mission: String(p["mission"] ?? ""),
          sharesAuthorized: p["sharesAuthorized"] as number,
          shares,
          treasury: INITIAL_TREASURY,
          valuation: INITIAL_VALUATION,
        },
        effects,
      };
    }
    case "charter_amendment": {
      return { ok: true, state: { ...base, sharesAuthorized: p["sharesAuthorized"] as number }, effects };
    }
    case "officer": {
      const office = p["office"] as Office;
      const did = p["did"] as string;
      const officers = new Map(state.officers);
      const replacedDid = officers.get(office);
      officers.set(office, did);
      effects.push({ type: "officer_seated", office, did, ...(replacedDid === undefined ? {} : { replacedDid }) });
      return { ok: true, state: { ...base, officers }, effects };
    }
    case "equity_grant": {
      const did = p["did"] as string;
      const grant = p["shares"] as number;
      const shares = new Map(state.shares);
      shares.set(did, sharesOf(state, did) + grant);
      const next = { ...base, shares };
      effects.push({ type: "equity_issued", did, shares: grant, totalIssued: totalIssued(next) });
      return { ok: true, state: next, effects };
    }
    case "comp": {
      const did = p["did"] as string;
      const salary = p["salary"] as number;
      const comp = new Map(state.comp);
      comp.set(did, salary);
      effects.push({ type: "comp_set", did, salary });
      return { ok: true, state: { ...base, comp }, effects };
    }
    case "work_item": {
      const id = proposal.id;
      const item: WorkItem = {
        id,
        title: String(p["title"]),
        assigneeDid: p["assigneeDid"] as string,
        openedBy: proposal.proposerDid,
        status: "open",
      };
      const workItems = new Map(state.workItems);
      workItems.set(id, item);
      effects.push({ type: "work_opened", id, title: item.title, assigneeDid: item.assigneeDid });
      // Doing the work requires the tool. The grant is an effect of the vote, not of
      // anyone's say-so — including the CEO who opened the item.
      effects.push({ type: "grant", did: item.assigneeDid, namespace: "repo.commit" });
      return { ok: true, state: { ...base, workItems }, effects };
    }
    case "product": {
      effects.push({ type: "product_selected", name: String(p["name"]) });
      return { ok: true, state: { ...base, productName: String(p["name"]) }, effects };
    }
    case "budget": {
      const delta = p["delta"] as number;
      const balance = state.treasury + delta;
      effects.push({ type: "treasury_changed", delta, balance });
      return { ok: true, state: { ...base, treasury: balance }, effects };
    }
    default:
      return { ok: true, state: base, effects };
  }
}

function closeFailed(state: CorpState, proposal: Proposal, reason: string): VoteResult {
  const closed = { ...proposal, status: "failed" as const };
  return {
    ok: true,
    state: { ...state, proposals: replaced(state, closed) },
    effects: [{ type: "proposal_failed", id: proposal.id, reason }],
  };
}

/**
 * Mark a work item complete. The first completion is the MVP milestone and re-values the
 * company; later ones do not. Simplicity is a feature: one dramatic jump, not a pricing
 * model pretending to precision.
 */
export function completeWork(
  state: CorpState,
  id: string,
  did: string,
): { ok: boolean; reason?: string; state: CorpState; effects: readonly CorpEffect[] } {
  const item = state.workItems.get(id);
  if (item === undefined) return { ok: false, reason: `no work item ${id}`, state, effects: [] };
  if (item.status !== "open") return { ok: false, reason: `${id} already complete`, state, effects: [] };
  if (item.assigneeDid !== did) return { ok: false, reason: "only the assignee may submit", state, effects: [] };

  const workItems = new Map(state.workItems);
  workItems.set(id, { ...item, status: "complete" });
  const isMvp = state.completedWork === 0;
  const valuation = isMvp ? Math.max(state.valuation, MVP_VALUATION) : state.valuation;
  return {
    ok: true,
    state: { ...state, workItems, valuation, completedWork: state.completedWork + 1 },
    effects: [{ type: "work_completed", id, valuation }],
  };
}

/** The scoreboard line for one agent: paper wealth, influence, and what it cost. */
export function standing(
  state: CorpState,
  did: string,
): { shares: number; pct: number; paperValue: number; offices: Office[]; salary: number } {
  const shares = sharesOf(state, did);
  const issued = totalIssued(state);
  const offices = OFFICES.filter((office) => state.officers.get(office) === did);
  return {
    shares,
    pct: issued === 0 ? 0 : shares / issued,
    paperValue: issued === 0 ? 0 : Math.round((shares / issued) * state.valuation),
    offices,
    salary: state.comp.get(did) ?? 0,
  };
}
