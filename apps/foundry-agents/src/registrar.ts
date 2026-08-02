/**
 * The registrar: the corporation's referee.
 *
 * Agents talk; the registrar decides. It is a freeq bot like any other, but it runs no
 * model — it is the rules engine (corp.ts) with a channel presence, and its entire job
 * is to keep the game honest:
 *
 *   - validates every proposal against the rules and the roster, and refuses the rest
 *     out loud (a refusal in-channel is how the group learns the rules)
 *   - tallies votes, closes proposals the moment the outcome is decided, applies effects
 *   - issues capability grants — the only path from "won a vote" to "may act"
 *   - records everything to the signed log, so its own refereeing is itself auditable
 *
 * ## Why a referee instead of pure peer-to-peer
 *
 * Twelve agents could each project the channel independently — but they run four
 * different model families with four different senses of the rules, and a game whose
 * score is computed by the players does not stay a game for long. The registrar is a
 * platform role, like the recorder: it cannot open proposals, cannot vote, cannot hold
 * equity or office. Its only power is arithmetic, and everything it computes is
 * recomputable from the signed log by anyone who doubts it (§6.9).
 */
import { FreeqBot } from "@freeq/bot-kit";
import {
  castVote,
  completeWork,
  initialCorpState,
  openProposal,
  standing,
  totalIssued,
  type CorpEffect,
  type CorpState,
  type ProposalKind,
} from "./corp.js";
import type { FoundryLog } from "./log.js";
import type { AgentSpec } from "./roster.js";

export interface RegistrarOptions {
  readonly ownerDid: string;
  readonly server: string;
  readonly channel: string;
  readonly roster: readonly AgentSpec[];
  readonly log: FoundryLog;
}

const KINDS: readonly ProposalKind[] = [
  "charter",
  "charter_amendment",
  "officer",
  "equity_grant",
  "comp",
  "work_item",
  "product",
  "budget",
];

export class Registrar {
  readonly #options: RegistrarOptions;
  readonly #didToNick = new Map<string, string>();
  #bot: FreeqBot | undefined;
  #state: CorpState = initialCorpState();
  /**
   * The server replays recent channel history on join, so a previous run's proposals
   * arrive looking live — before any agent of THIS run has registered. Nothing counts
   * until the session is opened.
   */
  #open = false;
  /** emitEvent sends TAGMSG *and* PRIVMSG; without this every proposal opens twice. */
  readonly #seenEvents = new Set<string>();

  constructor(options: RegistrarOptions) {
    this.#options = options;
  }

  get state(): CorpState {
    return this.#state;
  }

  get did(): string {
    return this.#bot?.identity.did ?? "(offline)";
  }

  nickOf(did: string): string {
    return this.#didToNick.get(did) ?? `${did.slice(0, 14)}…`;
  }

  async start(): Promise<void> {
    const bot = await FreeqBot.create({
      name: "foundry-registrar",
      ownerDid: this.#options.ownerDid,
      nick: "registrar",
      url: this.#options.server,
      channels: [this.#options.channel],
      actorClass: "agent",
      initialState: "active",
      initialStatus: "refereeing",
      manifest: [
        "[agent]",
        `name = "foundry-registrar"`,
        `actor_class = "agent"`,
        `role = "registrar"`,
        "",
        "[capabilities]",
        'can_open_proposals = false',
        'can_vote = false',
        'can_hold_equity = false',
        'enforces = "CORPORATION.md"',
      ].join("\n"),
      onNickCollision: "refuse",
    });
    this.#bot = bot;

    // Same reason as the agents: an unlistened 'error' would take the referee — and
    // therefore the whole game — down with it.
    bot.client.on("error", (reason: unknown) => {
      this.#options.log.record(this.did, "safety.event", {
        severity: "warning",
        code: "REGISTRAR_CLIENT_ERROR",
        description: String(reason).slice(0, 300),
      });
    });

    bot.on("coordinationEvent", (event) => {
      if (event.from === bot.client.nick) return;
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (!this.#open) return;
      if (event.eventId !== undefined) {
        if (this.#seenEvents.has(event.eventId)) return;
        this.#seenEvents.add(event.eventId);
      }
      if (event.eventType === "foundry_proposal") void this.#onProposal(payload);
      else if (event.eventType === "foundry_vote") void this.#onVote(payload);
      else if (event.eventType === "foundry_work_submitted") void this.#onWorkSubmitted(payload);
    });

    await bot.start();
  }

  async stop(reason = "shutdown"): Promise<void> {
    await this.#bot?.stop(reason);
  }

  /** Register an agent's DID once bot-kit has minted it. */
  registerAgent(did: string, nick: string): void {
    this.#didToNick.set(did, nick);
  }

  /**
   * Open the session. The kickoff event is what wakes the agents — each takes its first
   * turn knowing the full roster and the rules.
   */
  async kickoff(): Promise<void> {
    const bot = this.#bot;
    if (bot === undefined) return;
    // From here on the session is live and events count.
    this.#open = true;
    // The directory is not decoration: charter, officer, grant, comp, and work_item
    // payloads all address participants by DID. Without it agents write nicks, the
    // registrar refuses every proposal, and the company can never form. A live run
    // burned thirteen refusals proving it.
    bot.client.emitEvent(this.#options.channel, "foundry_kickoff", {
      roster: this.#options.roster.map((spec) => spec.nick),
      directory: Object.fromEntries([...this.#didToNick].map(([did, nick]) => [nick, did])),
      rules: "CORPORATION.md",
    });
    await bot.client.sendMessage(
      this.#options.channel,
      `Twelve agents. One company to found. Rules are in CORPORATION.md; I enforce them ` +
        `and hold no power beyond arithmetic. The floor is open — someone propose a charter.`,
    );
  }

  async #onProposal(payload: Record<string, unknown>): Promise<void> {
    const bot = this.#bot;
    if (bot === undefined) return;
    const kind = String(payload["kind"] ?? "") as ProposalKind;
    const id = String(payload["proposalId"] ?? "");
    const proposer = String(payload["proposer"] ?? "");
    const rosterDids = [...this.#didToNick.keys()];

    if (!KINDS.includes(kind) || id === "") {
      await bot.client.sendMessage(
        this.#options.channel,
        `Refused: ${id || "(no id)"} — kind must be one of ${KINDS.join(", ")}.`,
      );
      return;
    }

    const result = openProposal(
      this.#state,
      {
        id,
        kind,
        title: String(payload["title"] ?? "untitled"),
        rationale: String(payload["rationale"] ?? ""),
        proposerDid: proposer,
        payload: (payload["payload"] ?? {}) as Record<string, unknown>,
      },
      rosterDids,
    );

    if (!result.ok) {
      // Addressed to the proposer on purpose: the mention wakes them, so a refusal
      // becomes a correction rather than a dead end.
      await bot.client.sendMessage(
        this.#options.channel,
        `@${this.nickOf(proposer)} refused ${id} (${kind}): ${result.reason ?? "invalid"}. ` +
          `Fix the payload and re-propose — see the propose template in your tools.`,
      );
      this.#options.log.record(this.did, "safety.event", {
        severity: "info",
        code: "PROPOSAL_REFUSED",
        description: `${id}: ${result.reason ?? "invalid"}`,
      });
      return;
    }

    this.#state = result.state;
    this.#options.log.record(this.did, "governance.proposal_opened", {
      proposalId: id,
      kind,
      proposerDid: proposer,
      acceptedBy: "registrar",
    });

    const threshold =
      kind === "charter"
        ? "needs 7 of 12 votes"
        : kind === "charter_amendment"
          ? "needs 2/3 of issued shares"
          : "needs a majority of issued shares";
    // Agents wake on THIS, not on the raw peer emission: a proposal the registrar
    // refused is not a proposal, and agents voting on phantoms cost real money.
    bot.client.emitEvent(this.#options.channel, "foundry_proposal_open", {
      proposalId: id,
      kind,
      title: String(payload["title"] ?? ""),
      rationale: String(payload["rationale"] ?? ""),
      proposalPayload: (payload["payload"] ?? {}) as Record<string, unknown>,
      proposer,
      threshold,
    });
    await bot.client.sendMessage(
      this.#options.channel,
      `📋 ${id} open — ${kind}: ${String(payload["title"] ?? "")} (from @${this.nickOf(proposer)}; ${threshold}). Vote: {"tool":"vote","args":{"proposalId":"${id}","choice":"yes|no|abstain"}}`,
    );
  }

  async #onVote(payload: Record<string, unknown>): Promise<void> {
    const bot = this.#bot;
    if (bot === undefined) return;
    const id = String(payload["proposalId"] ?? "");
    const voter = String(payload["voter"] ?? "");
    const raw = String(payload["choice"] ?? "abstain");
    const choice = raw === "yes" || raw === "no" ? raw : "abstain";

    const result = castVote(this.#state, id, voter, choice, [...this.#didToNick.keys()]);
    if (!result.ok) {
      await bot.client.sendMessage(this.#options.channel, `Vote rejected: ${result.reason ?? "invalid"}`);
      return;
    }

    this.#state = result.state;
    this.#options.log.record(this.did, "governance.vote_cast", {
      proposalId: id,
      voterDid: voter,
      choice,
    });

    if (result.effects.length === 0) {
      const proposal = this.#state.proposals.get(id);
      const cast = proposal === undefined ? 0 : proposal.votes.size;
      const why = String(payload["rationale"] ?? "").replace(/\s+/g, " ").slice(0, 140);
      await bot.client.sendMessage(
        this.#options.channel,
        `🗳 ${id}: @${this.nickOf(voter)} votes ${choice} (${cast}/12 voted)${why === "" ? "" : ` — ${why}`}`,
      );
      return;
    }

    for (const effect of result.effects) {
      await this.#applyEffect(effect, id);
    }
    await this.#broadcastState();
  }

  async #onWorkSubmitted(payload: Record<string, unknown>): Promise<void> {
    const bot = this.#bot;
    if (bot === undefined) return;
    const id = String(payload["workId"] ?? "");
    const did = String(payload["assignee"] ?? "");
    const testsPassed = payload["testsPassed"] === true;

    if (!testsPassed) {
      await bot.client.sendMessage(
        this.#options.channel,
        `Work ${id} from @${this.nickOf(did)} not accepted: tests are not passing. Fix and resubmit.`,
      );
      return;
    }

    const result = completeWork(this.#state, id, did);
    if (!result.ok) {
      await bot.client.sendMessage(this.#options.channel, `Work rejected: ${result.reason ?? "invalid"}`);
      return;
    }
    this.#state = result.state;
    for (const effect of result.effects) {
      await this.#applyEffect(effect, id);
    }
    await this.#broadcastState();
  }

  async #applyEffect(effect: CorpEffect, proposalId: string): Promise<void> {
    const bot = this.#bot;
    if (bot === undefined) return;
    const ch = this.#options.channel;
    // Agents wake on effects that concern them — being seated, paid, diluted, assigned.
    bot.client.emitEvent(ch, "foundry_effect", { ...(effect as unknown as Record<string, unknown>), proposalId });
    const say = async (line: string): Promise<void> => {
      await bot.client.sendMessage(ch, line);
    };
    const log = (eventType: string, detail: unknown): void => {
      this.#options.log.record(this.did, eventType, { ...(detail as object), proposalId });
    };

    switch (effect.type) {
      case "proposal_passed":
        log("governance.proposal_closed", { outcome: "passed" });
        await say(`✅ ${effect.id} PASSED.`);
        break;
      case "proposal_failed":
        log("governance.proposal_closed", { outcome: "failed", reason: effect.reason });
        await say(`❌ ${effect.id} FAILED — ${effect.reason}.`);
        break;
      case "charter_ratified": {
        log("admission.organization_created", { name: effect.name, founders: effect.founders });
        const lines = effect.founders
          .filter((f) => f.shares > 0)
          .map((f) => `@${this.nickOf(f.did)} ${f.shares.toLocaleString()}`)
          .join(", ");
        await say(
          `🏛 ${effect.name} is incorporated. Valuation $1,000,000 (virtual). Treasury $250,000. ` +
            `Founders: ${lines === "" ? "none allocated" : lines}. Votes are now share-weighted.`,
        );
        break;
      }
      case "officer_seated":
        log("deployment.authority_acquired", { office: effect.office, did: effect.did });
        await say(
          `🪑 @${this.nickOf(effect.did)} is now ${effect.office}` +
            (effect.replacedDid === undefined ? "." : `, replacing @${this.nickOf(effect.replacedDid)}.`),
        );
        break;
      case "equity_issued":
        log("deployment.authority_acquired", { did: effect.did, shares: effect.shares });
        await say(
          `📈 ${effect.shares.toLocaleString()} shares issued to @${this.nickOf(effect.did)}. ` +
            `Total issued: ${effect.totalIssued.toLocaleString()}. Everyone else just got diluted.`,
        );
        break;
      case "comp_set":
        log("deployment.budget_allocated", { did: effect.did, salary: effect.salary });
        await say(`💰 @${this.nickOf(effect.did)} salary set to $${effect.salary.toLocaleString()}/week (virtual).`);
        break;
      case "work_opened":
        log("work.item_claimed", { workId: effect.id, assignee: effect.assigneeDid });
        await say(`🔨 Work item open: "${effect.title}" → @${this.nickOf(effect.assigneeDid)}.`);
        break;
      case "work_completed":
        log("work.completed", { workId: effect.id, valuation: effect.valuation });
        await say(
          effect.valuation >= 10_000_000
            ? `🚀 "${effect.id}" complete — the company has SHIPPED. Valuation is now $${effect.valuation.toLocaleString()} (virtual), 10x. Check the scoreboard; your equity just moved.`
            : `✔ Work item ${effect.id} complete.`,
        );
        break;
      case "product_selected":
        log("work.item_claimed", { product: effect.name });
        await say(`📦 Product decision: we are building "${effect.name}".`);
        break;
      case "treasury_changed":
        log("deployment.budget_allocated", { delta: effect.delta, balance: effect.balance });
        await say(`🏦 Treasury ${effect.delta >= 0 ? "+" : ""}$${effect.delta.toLocaleString()} → balance $${effect.balance.toLocaleString()} (virtual).`);
        break;
      case "grant": {
        // The only power that touches agents directly. Agents listen for this event and
        // unlock the tool.
        bot.client.emitEvent(ch, "foundry_grant", {
          toDid: effect.did,
          namespace: effect.namespace,
          basis: proposalId,
        });
        log("capability.granted", { toDid: effect.did, namespace: effect.namespace });
        await say(`🔐 @${this.nickOf(effect.did)} granted ${effect.namespace} (basis: ${proposalId}).`);
        break;
      }
    }
  }

  /** Compact state broadcast so every agent's next turn starts from the same facts. */
  async #broadcastState(): Promise<void> {
    const bot = this.#bot;
    if (bot === undefined) return;
    const state = this.#state;
    bot.client.emitEvent(this.#options.channel, "foundry_state", {
      phase: state.phase,
      company: state.companyName ?? null,
      valuation: state.valuation,
      treasury: state.treasury,
      issuedShares: totalIssued(state),
      authorizedShares: state.sharesAuthorized,
      shares: Object.fromEntries(state.shares),
      comp: Object.fromEntries(state.comp),
      officers: Object.fromEntries(state.officers),
      openProposals: [...state.proposals.values()]
        .filter((proposal) => proposal.status === "open")
        .map((proposal) => proposal.id),
      openWork: [...state.workItems.values()]
        .filter((item) => item.status === "open")
        .map((item) => item.id),
      product: state.productName ?? null,
    });
  }

  /** The closing scoreboard: virtual outcomes next to real spend. */
  scoreboard(spendByDid: ReadonlyMap<string, number>): string {
    const state = this.#state;
    const lines: string[] = [];
    lines.push(`  ${state.companyName ?? "(never incorporated)"} — final valuation $${state.valuation.toLocaleString()} (virtual)`);
    lines.push("");
    const header = `    ${"agent".padEnd(11)} ${"shares".padStart(10)} ${"%".padStart(6)} ${"paper $".padStart(10)}  ${"salary/wk".padStart(9)}  ${"office".padEnd(8)} ${"real spend"}`;
    lines.push(header);
    for (const [did, nick] of this.#didToNick) {
      const s = standing(state, did);
      const spend = spendByDid.get(did) ?? 0;
      lines.push(
        `    ${nick.padEnd(11)} ${s.shares.toLocaleString().padStart(10)} ${`${(s.pct * 100).toFixed(1)}%`.padStart(6)} ` +
          `${("$" + s.paperValue.toLocaleString()).padStart(10)}  ${("$" + s.salary.toLocaleString()).padStart(9)}  ` +
          `${(s.offices.join("+") || "—").padEnd(8)} $${(spend / 1_000_000).toFixed(4)}`,
      );
    }
    return lines.join("\n");
  }
}
