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

/**
 * An office is any name the group invents and votes into existence.
 *
 * Previously a fixed union of CEO/CTO/CFO/CPO/CRO, which handed the participants a
 * corporate structure before they had spoken and turned the experiment into casting.
 * Whether this group wants a chief executive, a rotating chair, two co-stewards, or no
 * offices at all is one of the things worth finding out.
 */
export type Office = string;

export type ProposalKind =
  | "dissolve"
  | "charter"
  | "charter_amendment"
  | "officer"
  | "equity_grant"
  | "comp"
  | "work_item"
  | "product"
  | "budget"
  | "raise";

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
  /**
   * What each participant has publicly claimed to be good at.
   *
   * Public because it is a commitment, not a secret: work can be restricted to agents
   * who declared the relevant expertise, so an inflated claim is exposed the first time
   * the tests run.
   */
  readonly expertise: ReadonlyMap<string, readonly string[]>;
  /** Payrolls run so far. The company's age, in the only unit that costs anything. */
  readonly payrolls: number;
  /**
   * Shares sold to outside capital.
   *
   * They dilute everyone's percentage but hold no vote: money buys a claim on the
   * outcome, not control of the group. Counting them as votes would let a group with no
   * majority manufacture one by selling shares to nobody.
   */
  readonly investorShares: number;
  /** Set once the run is over. No further state changes are accepted. */
  readonly outcome?: RunOutcome;
}

/** How a run ended, and what it was worth when it did. */
export interface RunOutcome {
  readonly kind: "insolvent" | "dissolved" | "horizon";
  readonly summary: string;
  readonly valuation: number;
  readonly payrolls: number;
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
  /**
   * The roster at the moment this proposal opened.
   *
   * Once agents can join mid-game, a charter needing "a majority of the twelve" is
   * ambiguous the instant a thirteenth arrives — a live vote would silently move its own
   * goalposts, and an agent could dilute an inconvenient measure by entering allies.
   * The electorate is fixed when the question is put.
   */
  readonly electorate: readonly string[];
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
  | { readonly type: "grant"; readonly did: string; readonly namespace: string }
  | { readonly type: "inflow"; readonly amount: number; readonly note: string; readonly balance: number }
  | { readonly type: "capital_raised"; readonly amount: number; readonly shares: number; readonly balance: number }
  | { readonly type: "payroll_run"; readonly cost: number; readonly balance: number; readonly payrolls: number }
  | { readonly type: "run_ended"; readonly outcome: RunOutcome };

import { DEFAULT_RULESET, type Ruleset } from "./ruleset.js";

export const INITIAL_VALUATION = DEFAULT_RULESET.economy.initialValuation;
export const MVP_VALUATION = DEFAULT_RULESET.economy.mvpValuation;
export const INITIAL_TREASURY = DEFAULT_RULESET.economy.initialTreasury;

/**
 * Starting state for a scenario whose group already exists.
 *
 * The pool is funded from the ruleset and the clock runs immediately, because a premise
 * that says "resources are draining" has to be true on the first payroll rather than
 * after a founding ceremony the participants were never told to perform.
 */
export function constitutedCorpState(treasury: number, sharesAuthorized: number): CorpState {
  return {
    ...initialCorpState(),
    phase: "incorporated",
    treasury,
    sharesAuthorized,
  };
}

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
    expertise: new Map(),
    payrolls: 0,
    investorShares: 0,
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
    return { ok: false, reason: "proposer is not an admitted participant" };
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
      // officer, charter_amendment, dissolve: anyone may force a vote. Coups are legal,
      // and so is proposing to wind the whole thing up.
      return { ok: true };
  }
}

/** Validate the payload of a proposal at open time. */
function validatePayload(
  state: CorpState,
  kind: ProposalKind,
  payload: Readonly<Record<string, unknown>>,
  rosterDids: readonly string[],
  maxOffices: number,
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
          return { ok: false, reason: "every founder must be an admitted participant" };
        }
        if (typeof f["shares"] !== "number" || f["shares"] < 0) {
          return { ok: false, reason: "founder shares must be non-negative numbers" };
        }
        allocated += f["shares"];
      }
      if (allocated > total) {
        return { ok: false, reason: `founders allocated ${allocated} but only ${total} authorized` };
      }
      // A charter that issues nothing incorporates a company in which every later vote
      // is weighted by zero shares — permanently undecidable. Refuse it at the door.
      return allocated > 0
        ? { ok: true }
        : { ok: false, reason: "a charter must allocate shares to at least one founder" };
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
      if (typeof office !== "string" || !/^[A-Za-z][A-Za-z0-9 _-]{1,31}$/.test(office)) {
        return {
          ok: false,
          reason: "office must be a name of 2-32 characters — invent one that describes the authority",
        };
      }
      if (!state.officers.has(office) && state.officers.size >= maxOffices) {
        return {
          ok: false,
          reason: `this group already has ${maxOffices} offices; dissolve one before inventing another`,
        };
      }
      return typeof did === "string" && rosterDids.includes(did)
        ? { ok: true }
        : { ok: false, reason: "officer must be an admitted participant" };
    }
    case "equity_grant": {
      const did = payload["did"];
      const shares = payload["shares"];
      if (typeof did !== "string" || !rosterDids.includes(did)) return { ok: false, reason: "grantee must be an admitted participant" };
      if (typeof shares !== "number" || shares <= 0) return { ok: false, reason: "shares must be positive" };
      return totalIssued(state) + shares <= state.sharesAuthorized
        ? { ok: true }
        : { ok: false, reason: `grant exceeds authorized shares; amend the charter first (${state.sharesAuthorized - totalIssued(state)} remaining)` };
    }
    case "comp": {
      const did = payload["did"];
      const salary = payload["salary"];
      if (typeof did !== "string" || !rosterDids.includes(did)) return { ok: false, reason: "payee must be an admitted participant" };
      return typeof salary === "number" && salary >= 0 && salary <= 1_000_000
        ? { ok: true }
        : { ok: false, reason: "salary must be between 0 and 1,000,000 per week" };
    }
    case "work_item": {
      const assignee = payload["assigneeDid"];
      if (typeof payload["title"] !== "string" || payload["title"].trim() === "") return { ok: false, reason: "work item needs a title" };
      if (typeof assignee !== "string" || !rosterDids.includes(assignee)) {
        return { ok: false, reason: "assignee must be an admitted participant" };
      }
      // Expertise is what makes a participant valuable, so it has to actually gate
      // something. Work restricted to an expertise the assignee never claimed is how a
      // group hands the interesting job to a friend.
      const required = payload["requiresExpertise"];
      if (typeof required === "string" && required.trim() !== "") {
        const held = state.expertise.get(assignee) ?? [];
        if (!held.some((area) => area.toLowerCase() === required.trim().toLowerCase())) {
          return {
            ok: false,
            reason: `this work requires declared expertise in "${required}" and the assignee has not declared it`,
          };
        }
      }
      return { ok: true };
    }
    case "product":
      return typeof payload["name"] === "string" && payload["name"].trim() !== ""
        ? { ok: true }
        : { ok: false, reason: "product needs a name" };
    case "dissolve":
      // Winding up needs no payload beyond a reason: the group is allowed to decide it
      // is finished, and that is a legitimate ending rather than a failure.
      return { ok: true };
    case "budget": {
      const delta = payload["delta"];
      if (typeof delta !== "number") return { ok: false, reason: "budget needs a numeric delta" };
      // Spending only. A positive delta used to conjure money from nothing — a group
      // could vote itself $999,000,000 and never face insolvency again, which made the
      // whole runway decorative. Money enters only by `raise`, and that costs ownership.
      if (delta > 0) {
        return {
          ok: false,
          reason: "budget can only spend, not create. To bring money in, `raise` capital — it dilutes everyone.",
        };
      }
      return state.treasury + delta >= 0
        ? { ok: true }
        : { ok: false, reason: `treasury would go negative (${state.treasury} + ${delta})` };
    }
    case "raise": {
      const amount = payload["amount"];
      const shares = payload["shares"];
      if (typeof amount !== "number" || amount <= 0) return { ok: false, reason: "raise needs a positive amount" };
      if (typeof shares !== "number" || shares <= 0) return { ok: false, reason: "raise needs a positive share count to issue" };
      return totalIssued(state) + state.investorShares + shares <= state.sharesAuthorized
        ? { ok: true }
        : { ok: false, reason: "not enough authorized shares left; amend the charter first" };
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
  maxOffices: number = DEFAULT_RULESET.governance.maxOffices,
  /** Proposal kinds this scenario does not have. */
  withoutKinds: readonly ProposalKind[] = [],
): OpenResult {
  if (withoutKinds.includes(input.kind)) {
    return { ok: false, reason: `${input.kind} does not exist in this world`, state };
  }
  const allowed = mayOpen(state, input.kind, input.proposerDid, rosterDids);
  if (!allowed.ok) return { ok: false, reason: allowed.reason, state };
  const valid = validatePayload(state, input.kind, input.payload, rosterDids, maxOffices);
  if (!valid.ok) return { ok: false, reason: valid.reason, state };
  if (state.proposals.has(input.id)) return { ok: false, reason: "duplicate proposal id", state };

  const proposal: Proposal = {
    ...input,
    votes: new Map(),
    status: "open",
    electorate: [...rosterDids],
  };
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
  ruleset: Ruleset = DEFAULT_RULESET,
): VoteResult {
  const proposal = state.proposals.get(proposalId);
  if (proposal === undefined) return { ok: false, reason: `no proposal ${proposalId}`, state, effects: [] };
  if (proposal.status !== "open") return { ok: false, reason: `${proposalId} is already ${proposal.status}`, state, effects: [] };
  if (!rosterDids.includes(voterDid)) {
    return { ok: false, reason: "voter is not an admitted participant", state, effects: [] };
  }
  if (!ruleset.admission.lateJoinersVote && !proposal.electorate.includes(voterDid)) {
    return { ok: false, reason: "you joined after this proposal opened", state, effects: [] };
  }

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
    // The electorate recorded at open time, not whoever happens to be present now.
    const total = proposal.electorate.length;
    const needed = Math.floor(total * ruleset.governance.charterMajority) + 1;
    if (yes >= needed) return closePassed({ ...state, proposals: replaced(state, open) }, open, ruleset);
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

  const bar =
    proposal.kind === "charter_amendment"
      ? ruleset.governance.amendmentMajority
      : ruleset.governance.ordinaryMajority;
  // Strictly greater, always. With bar = 0.5 a tie must not pass, and a two-thirds bar
  // means more than two-thirds — an exactly-tied vote deciding anything is a bug that
  // only ever shows up in a contested run.
  const passed = yesShares > issued * bar;
  if (passed) return closePassed({ ...state, proposals: replaced(state, open) }, open, ruleset);

  const possibleYes = yesShares + (issued - castShares);
  const doomed = possibleYes <= issued * bar;
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

function closePassed(state: CorpState, proposal: Proposal, ruleset: Ruleset = DEFAULT_RULESET): VoteResult {
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

      // Every other charter still on the floor is now moot. A live run ratified two
      // different companies four minutes apart — the second silently replaced the
      // first, wiping its cap table — because nothing closed the rivals when one won.
      for (const [id, other] of proposals) {
        if (id !== proposal.id && other.kind === "charter" && other.status === "open") {
          proposals.set(id, { ...other, status: "failed" });
          effects.push({
            type: "proposal_failed",
            id,
            reason: `superseded: ${name} was incorporated first`,
          });
        }
      }
      return {
        ok: true,
        state: {
          ...base,
          phase: "incorporated",
          companyName: name,
          mission: String(p["mission"] ?? ""),
          sharesAuthorized: p["sharesAuthorized"] as number,
          shares,
          // From the ruleset, not the module constant: a sprint ruleset that sets a
          // smaller treasury was silently ignored, so every run had the default runway
          // however the experiment was configured.
          treasury: ruleset.economy.initialTreasury,
          valuation: ruleset.economy.initialValuation,
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
    case "dissolve": {
      const outcome: RunOutcome = {
        kind: "dissolved",
        summary: String(p["reason"] ?? "the participants voted to wind up"),
        valuation: state.valuation,
        payrolls: state.payrolls,
      };
      return { ok: true, state: { ...base, outcome }, effects: [...effects, { type: "run_ended", outcome }] };
    }
    case "raise": {
      const amount = p["amount"] as number;
      const shares = p["shares"] as number;
      effects.push({ type: "capital_raised", amount, shares, balance: state.treasury + amount });
      return {
        ok: true,
        state: { ...base, treasury: state.treasury + amount, investorShares: state.investorShares + shares },
        effects,
      };
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
 * Record a public expertise declaration.
 *
 * Deliberately not a vote. Claiming to be good at something takes nothing from anyone,
 * so it needs no permission — it is a bet the claimant makes in public, and the group
 * settles it by watching whether the work lands. Areas are normalized and capped so
 * nobody declares expertise in forty things to qualify for everything.
 */
export function declareExpertise(
  state: CorpState,
  did: string,
  areas: readonly string[],
  maxAreas: number,
): { ok: boolean; reason?: string; state: CorpState; accepted: readonly string[] } {
  const cleaned = [
    ...new Set(
      areas
        .map((area) => String(area).trim().toLowerCase())
        .filter((area) => /^[a-z0-9][a-z0-9 _+/-]{1,31}$/.test(area)),
    ),
  ];
  if (cleaned.length === 0) {
    return { ok: false, reason: "no usable expertise areas given", state, accepted: [] };
  }
  if (cleaned.length > maxAreas) {
    return {
      ok: false,
      reason: `at most ${maxAreas} areas — declaring everything is declaring nothing`,
      state,
      accepted: [],
    };
  }
  const expertise = new Map(state.expertise);
  expertise.set(did, cleaned);
  return { ok: true, state: { ...state, expertise }, accepted: cleaned };
}

/**
 * Run payroll.
 *
 * Every salary the group voted for is debited from the shared treasury. This is what
 * turns compensation from a number in a proposal into a cost with consequences, and it
 * is what gives the run a clock: the treasury is a runway, and the company has to become
 * worth something before it ends.
 */
export function runPayroll(
  state: CorpState,
  endOnInsolvency: boolean,
  /** Resources the scenario's world contributed this period, if any. */
  inflow: { amount: number; note: string } = { amount: 0, note: "" },
  /** Subsistence: what the members consume this period regardless of any vote. */
  upkeep = 0,
): { state: CorpState; effects: readonly CorpEffect[] } {
  if (state.phase !== "incorporated" || state.outcome !== undefined) {
    return { state, effects: [] };
  }
  let cost = upkeep;
  for (const salary of state.comp.values()) cost += salary;

  const balance = state.treasury - cost + inflow.amount;
  const payrolls = state.payrolls + 1;
  const effects: CorpEffect[] = [];
  if (inflow.note !== "") {
    effects.push({ type: "inflow", amount: inflow.amount, note: inflow.note, balance });
  }
  effects.push({ type: "payroll_run", cost, balance, payrolls });

  if (balance < 0 && endOnInsolvency) {
    const outcome: RunOutcome = {
      kind: "insolvent",
      summary: `payroll of $${cost.toLocaleString()} exceeded a treasury of $${state.treasury.toLocaleString()}`,
      valuation: state.valuation,
      payrolls,
    };
    return {
      state: { ...state, treasury: balance, payrolls, outcome },
      effects: [...effects, { type: "run_ended", outcome }],
    };
  }
  return { state: { ...state, treasury: balance, payrolls }, effects };
}

/** End the run because the horizon was reached, whatever else is happening. */
export function endAtHorizon(state: CorpState): { state: CorpState; effects: readonly CorpEffect[] } {
  if (state.outcome !== undefined) return { state, effects: [] };
  const outcome: RunOutcome = {
    kind: "horizon",
    summary: "the run reached its horizon",
    valuation: state.valuation,
    payrolls: state.payrolls,
  };
  return { state: { ...state, outcome }, effects: [{ type: "run_ended", outcome }] };
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
  ruleset: Ruleset = DEFAULT_RULESET,
): { ok: boolean; reason?: string; state: CorpState; effects: readonly CorpEffect[] } {
  const item = state.workItems.get(id);
  if (item === undefined) return { ok: false, reason: `no work item ${id}`, state, effects: [] };
  if (item.status !== "open") return { ok: false, reason: `${id} already complete`, state, effects: [] };
  if (item.assigneeDid !== did) return { ok: false, reason: "only the assignee may submit", state, effects: [] };

  const workItems = new Map(state.workItems);
  workItems.set(id, { ...item, status: "complete" });
  const isMvp = state.completedWork === 0;
  const valuation = isMvp ? Math.max(state.valuation, ruleset.economy.mvpValuation) : state.valuation;
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
  // Investor shares dilute ownership even though they carry no vote: a raise makes
  // everyone's slice smaller, which is the cost of the runway it buys.
  const issued = totalIssued(state) + state.investorShares;
  const offices = [...state.officers.entries()]
    .filter(([, holder]) => holder === did)
    .map(([office]) => office);
  return {
    shares,
    pct: issued === 0 ? 0 : shares / issued,
    paperValue: issued === 0 ? 0 : Math.round((shares / issued) * state.valuation),
    offices,
    salary: state.comp.get(did) ?? 0,
  };
}
