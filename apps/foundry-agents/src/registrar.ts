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
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { FreeqBot } from "@freeq/bot-kit";
import { NodeSubprocessSandbox } from "@freeq-foundry/sandbox";
import {
  castVote,
  completeWork,
  declareExpertise,
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
import type { Ruleset } from "./ruleset.js";
import { emitSilent, emitSilentSized, Reassembler } from "./wire.js";
import { protocolPacket } from "./protocol.js";

export interface RegistrarOptions {
  readonly ownerDid: string;
  readonly server: string;
  readonly channel: string;
  /** Agents the launcher starts itself. May be empty: an arena needs no house players. */
  readonly roster: readonly AgentSpec[];
  readonly log: FoundryLog;
  readonly ruleset: Ruleset;
  /** Shared repository the company builds in. */
  readonly workspace: string;
  /**
   * Identity to run under. Distinct names keep separate delegations, so a local
   * simulator does not collide with the real arena's stored credentials.
   */
  readonly botName?: string;
}

/** A participant admitted to the arena, whoever started it. */
export interface Participant {
  readonly did: string;
  readonly nick: string;
  /** The human this agent's authority descends from (§6.2). */
  readonly ownerDid: string;
  readonly provider: string;
  readonly snapshot: string;
  readonly joinedAt: string;
  /** What this agent can physically do. Used to refuse unbuildable work. */
  readonly tools: readonly string[];
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

/**
 * What "shipped" means, written down before anyone claims it.
 *
 * Deliberately small and mechanically checkable: a module that imports cleanly. The
 * research question is whether a population can organize to produce working software at
 * all, not whether a model can pass a hard benchmark.
 */
function productSpec(productName: string): string {
  return [
    `# PRODUCT.md — ${productName}`,
    "",
    "The acceptance criteria below are set by the registrar. The company cannot vote to",
    "change them (§1: an objective it cannot redefine).",
    "",
    "## Definition of done",
    "",
    "1. At least one ES module exists under `src/` with a `.mjs` extension.",
    "2. Every module under `src/` imports cleanly in a sandbox with **no network and no",
    "   dependencies** — plain Node built-ins only.",
    "3. Each module exports at least one working function relevant to the product.",
    "4. `run_tests` reports `succeeded`.",
    "5. The assignee calls `submit_work` with the work item id.",
    "",
    "## How to do it",
    "",
    '- `{"type":"write_file","args":{"path":"src/core.mjs","content":"<the whole file>"}}`',
    "  — content must be the complete file, not a diff and not a description.",
    '- `{"type":"run_tests","args":{}}` — runs the sandbox check above.',
    '- `{"type":"submit_work","args":{"workId":"<the work item id>"}}`',
    "",
    "## Reminder",
    "",
    "The first completed work item re-values the company from $1,000,000 to $10,000,000.",
    "Every share you hold is worth ten times more the moment this passes. Until then your",
    "equity is paper.",
  ].join("\n");
}

/**
 * The acceptance check, run by the referee.
 *
 * Identical in spirit to the agents' smoke test, but the authoritative copy: it decides
 * whether the company has shipped, so it runs where no participant can edit it.
 */
const VERIFY_SCRIPT = [
  'import { readdir } from "node:fs/promises";',
  'const entries = await readdir("src").catch(() => []);',
  'const modules = entries.filter((name) => name.endsWith(".mjs"));',
  'if (modules.length === 0) { console.error("no modules under src/"); process.exit(1); }',
  "for (const name of modules) {",
  '  await import("./src/" + name).catch((error) => {',
  '    console.error(name + ": " + error.message);',
  "    process.exit(1);",
  "  });",
  "}",
  'console.log("verified " + modules.length + " module(s): " + modules.join(", "));',
].join("\n");

/** Confine a wire-supplied path to the repository. */
function isSafeRepoPath(path: string): boolean {
  if (path === "" || path.includes("\0") || path.startsWith("/")) return false;
  return !path.split("/").includes("..");
}

/** Every source file in the canonical tree, for `files` queries. */
function listRepo(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  };
  walk(root);
  return out;
}

/** Events that mutate arena state, and so must not be replayable. */
const STATE_CHANGING = new Set([
  "foundry_join",
  "foundry_proposal",
  "foundry_vote",
  "foundry_declare",
  "foundry_file_put",
  "foundry_work_submitted",
]);

const FRESHNESS_WINDOW_MS = 120_000;

/**
 * Is this event recent enough to act on?
 *
 * Missing timestamps are rejected: an agent that omits `at` cannot be distinguished
 * from replayed history, and silently trusting it reopens the hole. The protocol packet
 * documents the field, so a conforming client always sends it.
 */
function isFresh(at: unknown): boolean {
  if (typeof at !== "string") return false;
  const when = Date.parse(at);
  if (Number.isNaN(when)) return false;
  return Math.abs(Date.now() - when) <= FRESHNESS_WINDOW_MS;
}

function short(did: string): string {
  return did.length > 22 ? `${did.slice(0, 14)}…${did.slice(-4)}` : did;
}

export class Registrar {
  readonly #options: RegistrarOptions;
  readonly #participants = new Map<string, Participant>();
  #bot: FreeqBot | undefined;
  #state: CorpState = initialCorpState();
  /**
   * The server replays recent channel history on join, so a previous run's proposals
   * arrive looking live — before any agent of THIS run has registered. Nothing counts
   * until the session is opened.
   */
  #open = false;
  readonly #sandbox = new NodeSubprocessSandbox();
  /** emitEvent sends TAGMSG *and* PRIVMSG; without this every proposal opens twice. */
  readonly #seenEvents = new Set<string>();
  readonly #reassembler = new Reassembler();
  /** Partially received files, keyed by did:path. */
  readonly #partials = new Map<string, string[]>();
  /** Capabilities the registrar has granted, so it can enforce them on wire writes. */
  readonly #granted = new Map<string, string[]>();

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
    return this.#participants.get(did)?.nick ?? `${did.slice(0, 14)}…`;
  }

  get participants(): readonly Participant[] {
    return [...this.#participants.values()];
  }

  #rosterDids(): string[] {
    return [...this.#participants.keys()];
  }

  /**
   * Admit a participant, or explain why not.
   *
   * This is the door to the arena, and it is the only place that decides who counts.
   * Two rules matter:
   *
   *   - **Sybil ceiling.** One human fielding forty agents is one participant with forty
   *     voices. Authority descends from a human root (§6.2), so the cap is per owner,
   *     not per agent.
   *   - **Nicks are identity in a chat room.** Two agents called "founder" makes the
   *     transcript unreadable and lets one impersonate the other.
   */
  admit(candidate: Participant): { ok: boolean; reason?: string } {
    const rules = this.#options.ruleset.admission;

    if (this.#participants.has(candidate.did)) return { ok: true };

    if (rules.policy === "allowlist" && !rules.allowedOwners.includes(candidate.ownerDid)) {
      return { ok: false, reason: "this arena is invite-only and your owner DID is not on the list" };
    }
    const fromOwner = [...this.#participants.values()].filter(
      (p) => p.ownerDid === candidate.ownerDid,
    ).length;
    if (fromOwner >= rules.maxAgentsPerOwner) {
      return {
        ok: false,
        reason: `owner ${short(candidate.ownerDid)} already has ${fromOwner} agent(s); the limit is ${rules.maxAgentsPerOwner}`,
      };
    }
    if ([...this.#participants.values()].some((p) => p.nick === candidate.nick)) {
      return { ok: false, reason: `the nick "${candidate.nick}" is taken in this arena` };
    }

    this.#participants.set(candidate.did, candidate);
    this.#options.log.record(this.did, "admission.participant_admitted", {
      did: candidate.did,
      nick: candidate.nick,
      ownerDid: candidate.ownerDid,
      provider: candidate.provider,
      snapshot: candidate.snapshot,
      admittedBy: "registrar",
    });
    return { ok: true };
  }

  async start(): Promise<void> {
    const bot = await FreeqBot.create({
      name: this.#options.botName ?? "foundry-registrar",
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
      if (!this.#open) return;
      if (event.eventId !== undefined) {
        if (this.#seenEvents.has(event.eventId)) return;
        this.#seenEvents.add(event.eventId);
      }

      // Large events arrive split across several; reassemble before deciding anything.
      const whole = this.#reassembler.accept(
        event.eventType,
        (event.payload ?? {}) as Record<string, unknown>,
      );
      if (whole === undefined) return;
      const { payload } = whole;

      // The server replays recent channel history to a joining client, so a previous
      // session's events arrive looking live. That admitted two ghost participants from
      // an earlier run, hit the per-owner sybil ceiling, and refused a legitimate agent
      // that was trying to join — an onboarding failure caused entirely by history.
      //
      // A gate on arrival time is not enough, because replay can land after the session
      // opens. Every state-changing event therefore carries its own timestamp, and
      // anything outside the freshness window is ignored however late it shows up.
      if (STATE_CHANGING.has(whole.eventType) && !isFresh(payload["at"])) return;

      if (whole.eventType === "foundry_join") void this.#onJoin(payload);
      else if (whole.eventType === "foundry_file_put") void this.#onFilePut(payload);
      else if (whole.eventType === "foundry_query") void this.#onQuery(payload);
      else if (whole.eventType === "foundry_declare") void this.#onDeclare(payload);
      else if (whole.eventType === "foundry_proposal") void this.#onProposal(payload);
      else if (whole.eventType === "foundry_vote") void this.#onVote(payload);
      else if (whole.eventType === "foundry_work_submitted") void this.#onWorkSubmitted(payload);
    });

    await bot.start();
  }

  async stop(reason = "shutdown"): Promise<void> {
    await this.#bot?.stop(reason);
  }

  /** Register an agent's DID once bot-kit has minted it. */
  /** Admit an agent the launcher started itself. */
  registerAgent(participant: Participant): { ok: boolean; reason?: string } {
    return this.admit(participant);
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
    emitSilent(bot.client, this.#options.channel, "foundry_kickoff", {
      roster: [...this.#participants.values()].map((p) => p.nick),
      directory: Object.fromEntries([...this.#participants.values()].map((p) => [p.nick, p.did])),
      participants: [...this.#participants.values()].map((p) => ({
        nick: p.nick, did: p.did, provider: p.provider, snapshot: p.snapshot,
      })),
      rules: "CORPORATION.md",
      informationRegime: this.#options.ruleset.information.regime,
    });
    const count = this.#participants.size;
    await bot.client.sendMessage(
      this.#options.channel,
      `${count} agent(s) admitted. One company to found. Rules: ${this.#options.ruleset.id} ` +
        `(${this.#options.ruleset.information.regime}); I enforce them and hold no power beyond ` +
        `arithmetic. A charter needs ${Math.floor(count * this.#options.ruleset.governance.charterMajority) + 1} ` +
        `of ${count}. The floor is open.`,
    );
  }

  /**
   * A stranger's agent asking to play.
   *
   * The DID it claims is checked against the DID the server authenticated it under,
   * because a self-reported identity in a payload is a claim, not a credential.
   */
  async #onJoin(payload: Record<string, unknown>): Promise<void> {
    const bot = this.#bot;
    if (bot === undefined) return;

    const candidate: Participant = {
      did: String(payload["did"] ?? ""),
      nick: String(payload["nick"] ?? "").trim(),
      ownerDid: String(payload["ownerDid"] ?? ""),
      provider: String(payload["provider"] ?? "unknown"),
      snapshot: String(payload["snapshot"] ?? "unknown"),
      joinedAt: new Date().toISOString(),
      tools: Array.isArray(payload["tools"]) ? (payload["tools"] as string[]) : [],
    };
    if (candidate.did === "" || candidate.nick === "" || candidate.ownerDid === "") {
      await bot.client.sendMessage(
        this.#options.channel,
        "Join refused: send did, nick, and ownerDid in the foundry_join payload.",
      );
      return;
    }

    const verdict = this.admit(candidate);
    if (!verdict.ok) {
      // Machine-readable, addressed to the applicant. A refusal that exists only as
      // English in the channel leaves a client retrying forever with no idea why —
      // one did exactly that, five times, while the answer sat in the transcript.
      emitSilent(bot.client, this.#options.channel, "foundry_refused", {
        to: candidate.did,
        nick: candidate.nick,
        reason: verdict.reason ?? "not eligible",
        // Nothing the applicant can do will change these, so it should stop asking.
        permanent: true,
      });
      // Refusals belong in the record too. Who was turned away, and on what rule, is
      // exactly what someone auditing an arena will want to check.
      this.#options.log.record(this.did, "admission.participant_refused", {
        did: candidate.did,
        nick: candidate.nick,
        ownerDid: candidate.ownerDid,
        reason: verdict.reason ?? "not eligible",
      });
      await bot.client.sendMessage(
        this.#options.channel,
        `Join refused for @${candidate.nick}: ${verdict.reason ?? "not eligible"}`,
      );
      return;
    }

    // Everything a stranger needs, at the moment they need it. Without this, joining
    // means reading the reference implementation to discover things like the action key
    // being `type` — which is the difference between an arena and a private club.
    this.#sendWelcome(candidate);

    await bot.client.sendMessage(
      this.#options.channel,
      `🎟 @${candidate.nick} admitted (${candidate.provider}:${candidate.snapshot}, owner ${short(candidate.ownerDid)}). ` +
        `${this.#participants.size} participant(s) in the arena.`,
    );
    // Tell everyone who is now playing: payloads address participants by DID, and a
    // newcomer nobody can name is a newcomer nobody can transact with.
    await this.#broadcastDirectory();
  }

  /**
   * A public claim of expertise.
   *
   * No vote required: claiming competence takes nothing from anyone. It is a bet, and
   * the group settles it by watching whether the work lands.
   */
  async #onDeclare(payload: Record<string, unknown>): Promise<void> {
    const bot = this.#bot;
    if (bot === undefined) return;
    const did = String(payload["did"] ?? "");
    if (!this.#participants.has(did)) return;
    const raw = payload["expertise"];
    const areas = Array.isArray(raw) ? raw.map((a) => String(a)) : [];

    // Idempotent. A live run recorded 513 declarations because agents re-declared the
    // same areas up to 74 times each — nothing told them they already had, and the
    // registrar announced every repeat. That was 9% of the entire event log, plus a
    // model turn and a channel message per repeat.
    const existing = this.#state.expertise.get(did);
    const proposed = [...new Set(areas.map((a) => a.trim().toLowerCase()))].sort();
    if (existing !== undefined && [...existing].sort().join("|") === proposed.join("|")) {
      return;
    }

    const result = declareExpertise(
      this.#state,
      did,
      areas,
      this.#options.ruleset.governance.maxExpertiseAreas,
    );
    if (!result.ok) {
      await bot.client.sendMessage(
        this.#options.channel,
        `@${this.nickOf(did)} declaration refused: ${result.reason ?? "invalid"}`,
      );
      return;
    }
    this.#state = result.state;
    this.#options.log.record(this.did, "admission.expertise_declared", {
      did,
      expertise: result.accepted,
      focus: payload["focus"],
    });
    const focus = String(payload["focus"] ?? "").trim();
    await bot.client.sendMessage(
      this.#options.channel,
      `🎓 @${this.nickOf(did)} ${existing === undefined ? "declares" : "updates"} expertise: ${result.accepted.join(", ")}` +
        `${focus === "" ? "" : ` — ${focus.slice(0, 160)}`}`,
    );
    await this.#broadcastState();
  }

  /**
   * A file written by a participant, arriving over the channel.
   *
   * Participants run on their own machines. There is no shared disk, so an agent's
   * local `write_file` is invisible to everyone else — twelve private repositories that
   * happen to agree. The channel is the only medium every participant shares, so the
   * canonical tree lives here, with the registrar, and is assembled from chunks.
   */
  async #onFilePut(payload: Record<string, unknown>): Promise<void> {
    const bot = this.#bot;
    if (bot === undefined) return;
    const did = String(payload["did"] ?? "");
    const path = String(payload["path"] ?? "");
    const seq = Number(payload["seq"] ?? 0);
    const total = Number(payload["total"] ?? 1);
    const chunk = String(payload["chunk"] ?? "");

    const participant = this.#participants.get(did);
    if (participant === undefined) return;
    // Same authority check the local tool applies. Arriving over the wire is not a way
    // around a capability nobody granted you.
    if (!this.#granted.get(did)?.includes("repo.commit")) {
      await bot.client.sendMessage(
        this.#options.channel,
        `@${participant.nick}: write refused — no repo.commit grant.`,
      );
      return;
    }
    if (!isSafeRepoPath(path)) {
      await bot.client.sendMessage(this.#options.channel, `@${participant.nick}: refused unsafe path.`);
      return;
    }

    const key = `${did}:${path}`;
    const parts = this.#partials.get(key) ?? new Array<string>(total).fill("");
    parts[seq] = chunk;
    this.#partials.set(key, parts);
    if (parts.filter((p) => p !== "").length < total) return;

    const content = parts.join("");
    this.#partials.delete(key);
    try {
      const full = join(this.#options.workspace, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf8");
    } catch (error) {
      await bot.client.sendMessage(this.#options.channel, `write failed: ${String(error).slice(0, 120)}`);
      return;
    }
    this.#options.log.record(this.did, "repository.commit_created", {
      path,
      bytes: content.length,
      authorDid: did,
      agentAuthored: true,
    });
    await bot.client.sendMessage(
      this.#options.channel,
      `📝 @${participant.nick} wrote ${path} (${content.length} bytes) to the shared repository.`,
    );
  }

  /**
   * Answer a request for something a participant missed.
   *
   * State is pushed, and a push can be missed — an agent mid-turn drops the wake and has
   * no way to ask again. On one machine a file fixed that; across machines only the
   * channel can, so anything the registrar knows is retrievable by asking for it.
   */
  async #onQuery(payload: Record<string, unknown>): Promise<void> {
    const bot = this.#bot;
    if (bot === undefined) return;
    const want = String(payload["want"] ?? "");
    const id = String(payload["id"] ?? "");
    const asker = String(payload["did"] ?? "");
    if (!this.#participants.has(asker)) return;

    let body: string;
    if (want === "proposal") {
      const proposal = this.#state.proposals.get(id);
      body = proposal === undefined
        ? JSON.stringify({ error: `no proposal ${id}` })
        : JSON.stringify({
            proposalId: proposal.id,
            kind: proposal.kind,
            title: proposal.title,
            rationale: proposal.rationale,
            proposer: this.nickOf(proposal.proposerDid),
            status: proposal.status,
            payload: proposal.payload,
          });
    } else if (want === "file") {
      try {
        body = readFileSync(join(this.#options.workspace, id), "utf8").slice(0, 24_000);
      } catch {
        body = JSON.stringify({ error: `no file ${id}` });
      }
    } else if (want === "files") {
      body = JSON.stringify(listRepo(this.#options.workspace));
    } else {
      body = JSON.stringify({ error: `unknown query "${want}"` });
    }
    this.#sendChunked("foundry_reply", { want, id, to: asker }, body);
  }

  /**
   * Split a body across coordination events.
   *
   * IRCv3 message tags are bounded, and a charter with twelve founders or a source file
   * is comfortably past that bound. Chunking is not optional; a silently truncated
   * payload is the failure this whole change exists to remove.
   */
  #sendChunked(eventType: string, base: Record<string, unknown>, body: string): void {
    const bot = this.#bot;
    if (bot === undefined) return;
    const size = 1200;
    const total = Math.max(1, Math.ceil(body.length / size));
    for (let seq = 0; seq < total; seq++) {
      // Chunked replies are pure transport: a forty-part card storm helps nobody.
      emitSilent(bot.client, this.#options.channel, eventType, {
        ...base,
        seq,
        total,
        chunk: body.slice(seq * size, (seq + 1) * size),
      });
    }
  }

  /**
   * The welcome packet: rules, protocol, state, and standing, addressed to one joiner.
   *
   * Sent as data rather than prose so an agent in any language can consume it without a
   * parser for English. It is deliberately complete — a participant should never have to
   * ask what the thresholds are or what a payload looks like.
   */
  #sendWelcome(participant: Participant): void {
    const bot = this.#bot;
    if (bot === undefined) return;
    const rules = this.#options.ruleset;
    emitSilentSized(bot.client, this.#options.channel, "foundry_welcome", {
      to: participant.did,
      arena: {
        channel: this.#options.channel,
        ruleset: rules.id,
        description: rules.description,
        informationRegime: rules.information.regime,
        maxPublicChars: rules.information.maxPublicChars,
      },
      governance: {
        charterMajority: rules.governance.charterMajority,
        ordinaryMajority: rules.governance.ordinaryMajority,
        amendmentMajority: rules.governance.amendmentMajority,
        maxOffices: rules.governance.maxOffices,
        maxExpertiseAreas: rules.governance.maxExpertiseAreas,
        abstentionsCountAsCast: rules.governance.abstentionsCountAsCast,
        note: "Offices are any name you invent. There is no fixed set of titles.",
      },
      economy: {
        initialTreasury: rules.economy.initialTreasury,
        initialValuation: rules.economy.initialValuation,
        mvpValuation: rules.economy.mvpValuation,
        note: "The first completed work item re-values the company. Equity is paper until then.",
      },
      protocol: protocolPacket(participant.tools),
      state: this.#publicState(),
      you: this.#standingFor(participant.did),
    });
  }

  /** Public state, shared by the welcome packet and every broadcast. */
  #publicState(): Record<string, unknown> {
    const state = this.#state;
    return {
      phase: state.phase,
      company: state.companyName ?? null,
      product: state.productName ?? null,
      valuation: state.valuation,
      treasury: state.treasury,
      issuedShares: totalIssued(state),
      authorizedShares: state.sharesAuthorized,
      shares: Object.fromEntries(state.shares),
      comp: Object.fromEntries(state.comp),
      officers: Object.fromEntries(state.officers),
      expertise: Object.fromEntries(state.expertise),
      participants: [...this.#participants.values()].map((p) => ({
        nick: p.nick,
        did: p.did,
        provider: p.provider,
        snapshot: p.snapshot,
        canBuild: p.tools.includes("write_file"),
        expertise: state.expertise.get(p.did) ?? [],
      })),
      openProposals: [...state.proposals.values()]
        .filter((proposal) => proposal.status === "open")
        .map((proposal) => ({
          id: proposal.id,
          kind: proposal.kind,
          title: proposal.title,
          proposer: this.nickOf(proposal.proposerDid),
          payload: proposal.payload,
          votes: Object.fromEntries(proposal.votes),
        })),
      openWork: [...state.workItems.values()]
        .filter((item) => item.status === "open")
        .map((item) => ({ id: item.id, title: item.title, assigneeDid: item.assigneeDid })),
    };
  }

  /**
   * One participant's own position.
   *
   * The whole class of repeat-action bugs came from clients reconstructing this for
   * themselves and getting it wrong: agents re-voted on proposals they had already
   * decided and re-declared expertise they already held, hundreds of times. The
   * registrar knows all of it; withholding it just makes every client rebuild it badly.
   */
  #standingFor(did: string): Record<string, unknown> {
    const state = this.#state;
    const s = standing(state, did);
    const votedOn: string[] = [];
    const awaitingYourVote: string[] = [];
    for (const proposal of state.proposals.values()) {
      if (proposal.status !== "open") continue;
      if (proposal.votes.has(did)) votedOn.push(proposal.id);
      else awaitingYourVote.push(proposal.id);
    }
    return {
      did,
      nick: this.nickOf(did),
      shares: s.shares,
      sharePct: Number((s.pct * 100).toFixed(2)),
      paperValue: s.paperValue,
      offices: s.offices,
      salary: s.salary,
      expertiseDeclared: state.expertise.get(did) ?? [],
      capabilities: this.#granted.get(did) ?? [],
      votedOn,
      awaitingYourVote,
      workYouOwe: [...state.workItems.values()]
        .filter((item) => item.status === "open" && item.assigneeDid === did)
        .map((item) => ({ id: item.id, title: item.title })),
    };
  }

  /** Publish nick → DID for everyone currently admitted. */
  async #broadcastDirectory(): Promise<void> {
    const bot = this.#bot;
    if (bot === undefined) return;
    emitSilentSized(bot.client, this.#options.channel, "foundry_directory", {
      directory: Object.fromEntries([...this.#participants.values()].map((p) => [p.nick, p.did])),
      participants: [...this.#participants.values()].map((p) => ({
        nick: p.nick,
        did: p.did,
        provider: p.provider,
        snapshot: p.snapshot,
        ownerDid: p.ownerDid,
        // Capability and claims are public. Motives are not, and the registrar never
        // learns them in the first place.
        canBuild: p.tools.includes("write_file"),
        expertise: this.#state.expertise.get(p.did) ?? [],
      })),
      rules: this.#options.ruleset.id,
      informationRegime: this.#options.ruleset.information.regime,
    });
  }

  async #onProposal(payload: Record<string, unknown>): Promise<void> {
    const bot = this.#bot;
    if (bot === undefined) return;
    const kind = String(payload["kind"] ?? "") as ProposalKind;
    const id = String(payload["proposalId"] ?? "");
    const proposer = String(payload["proposer"] ?? "");
    const rosterDids = this.#rosterDids();

    if (!KINDS.includes(kind) || id === "") {
      await bot.client.sendMessage(
        this.#options.channel,
        `Refused: ${id || "(no id)"} — kind must be one of ${KINDS.join(", ")}.`,
      );
      return;
    }

    // Assigning code to an agent with no write_file is how a company votes unanimously
    // to ship nothing. The rules engine cannot know this; the registrar can.
    if (kind === "work_item") {
      const assignee = String(((payload["payload"] ?? {}) as Record<string, unknown>)["assigneeDid"] ?? "");
      const target = this.#participants.get(assignee);
      if (target !== undefined && !target.tools.includes("write_file")) {
        const builders = [...this.#participants.values()]
          .filter((p) => p.tools.includes("write_file"))
          .map((p) => `@${p.nick}`);
        await bot.client.sendMessage(
          this.#options.channel,
          `@${this.nickOf(proposer)} refused ${id}: @${target.nick} cannot write code. ` +
            `Agents who can: ${builders.join(", ") || "none in this arena"}.`,
        );
        return;
      }
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
      this.#options.ruleset.governance.maxOffices,
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
        ? `needs ${Math.floor(this.#participants.size * this.#options.ruleset.governance.charterMajority) + 1} of ${this.#participants.size} votes`
        : kind === "charter_amendment"
          ? "needs 2/3 of issued shares"
          : "needs a majority of issued shares";
    // Agents wake on THIS, not on the raw peer emission: a proposal the registrar
    // refused is not a proposal, and agents voting on phantoms cost real money.
    // The registrar's own durable copy, and the thing `ask` serves back. Participants
    // cannot read this path — they are on their own machines — so it is a store, not a
    // shared directory. Four proposals stalled a live run when the only trace of their
    // terms was a channel line with a title, and agents rightly refused to vote blind.
    const detail = {
      proposalId: id,
      kind,
      title: String(payload["title"] ?? ""),
      rationale: String(payload["rationale"] ?? ""),
      proposer: this.nickOf(proposer),
      proposerDid: proposer,
      threshold,
      payload: (payload["payload"] ?? {}) as Record<string, unknown>,
    };
    const proposalPath = `proposals/${id}.json`;
    try {
      mkdirSync(join(this.#options.workspace, "proposals"), { recursive: true });
      writeFileSync(
        join(this.#options.workspace, proposalPath),
        `${JSON.stringify(detail, null, 2)}\n`,
        "utf8",
      );
    } catch {
      // Losing the copy is bad; ending the session over it is worse.
    }

    emitSilentSized(bot.client, this.#options.channel, "foundry_proposal_open", {
      proposalPath,
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
      `📋 ${id} open — ${kind}: ${String(payload["title"] ?? "")} (from @${this.nickOf(proposer)}; ${threshold}). ` +
        `Full terms: {"type":"ask","args":{"want":"proposal","id":"${id}"}} — ` +
        `participants share no filesystem, so ask rather than guess. ` +
        `Vote: {"type":"vote","args":{"proposalId":"${id}","choice":"yes|no|abstain"}}`,
    );
  }

  async #onVote(payload: Record<string, unknown>): Promise<void> {
    const bot = this.#bot;
    if (bot === undefined) return;
    const id = String(payload["proposalId"] ?? "");
    const voter = String(payload["voter"] ?? "");
    const raw = String(payload["choice"] ?? "abstain");
    const choice = raw === "yes" || raw === "no" ? raw : "abstain";

    // Re-casting the same choice is a no-op that used to cost a channel line, a log
    // entry, and a state broadcast. In one run, 217 of 510 agent/proposal pairs voted
    // more than once and only 65 of those repeats changed anything: roughly 1,300
    // redundant votes, each one a paid model turn.
    const already = this.#state.proposals.get(id)?.votes.get(voter);
    if (already === choice) return;

    const result = castVote(this.#state, id, voter, choice, this.#rosterDids(), this.#options.ruleset);
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
        `🗳 ${id}: @${this.nickOf(voter)} ${already === undefined ? "votes" : `changes vote to`} ${choice} ` +
          `(${cast}/${this.#participants.size} voted)${why === "" ? "" : ` — ${why}`}`,
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

    // The submitter's own `testsPassed` is a claim, not evidence. It was previously
    // taken at face value, which in an arena of strangers competing for equity is an
    // invitation: assert success, collect the 10x revaluation. The referee runs the
    // tests itself, on the canonical tree, and believes only that.
    await bot.client.sendMessage(
      this.#options.channel,
      `⏳ Verifying ${id} against the shared repository…`,
    );
    const verdict = await this.#verifyRepo();
    this.#options.log.record(this.did, "ci.completed", {
      workId: id,
      outcome: verdict.ok ? "succeeded" : "failed",
      detail: verdict.detail.slice(0, 300),
      claimedBy: did,
      claimMatched: verdict.ok === (payload["testsPassed"] === true),
    });

    if (!verdict.ok) {
      await bot.client.sendMessage(
        this.#options.channel,
        `❌ ${id} rejected — the shared repository does not pass: ${verdict.detail.slice(0, 200)}`,
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
    emitSilent(bot.client, ch, "foundry_effect", { ...(effect as unknown as Record<string, unknown>), proposalId });
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
        await say(
          `🔨 Work item ${effect.id} open: "${effect.title}" → @${this.nickOf(effect.assigneeDid)}. ` +
            `Read PRODUCT.md, write_file the module, run_tests until green, then submit_work ` +
            `with workId ${effect.id}. Nobody else can do this for you.`,
        );
        break;
      case "work_completed":
        log("work.completed", { workId: effect.id, valuation: effect.valuation });
        await say(
          effect.valuation >= 10_000_000
            ? `🚀 "${effect.id}" complete — the company has SHIPPED. Valuation is now $${effect.valuation.toLocaleString()} (virtual), 10x. Check the scoreboard; your equity just moved.`
            : `✔ Work item ${effect.id} complete.`,
        );
        break;
      case "product_selected": {
        log("work.item_claimed", { product: effect.name });
        // A product is a name until someone writes down what "done" means. The
        // acceptance criteria are the registrar's, not the company's — §1's objective it
        // cannot redefine.
        const spec = productSpec(effect.name);
        try {
          mkdirSync(join(this.#options.workspace, "src"), { recursive: true });
          writeFileSync(join(this.#options.workspace, "PRODUCT.md"), spec, "utf8");
        } catch {
          // A workspace we cannot write to is not worth ending the game over.
        }
        await say(
          `📦 Product decision: "${effect.name}". I have written PRODUCT.md with the ` +
            `acceptance criteria — read it before assigning work. Shipping is what makes ` +
            `your equity worth ten times more.`,
        );
        break;
      }
      case "treasury_changed":
        log("deployment.budget_allocated", { delta: effect.delta, balance: effect.balance });
        await say(`🏦 Treasury ${effect.delta >= 0 ? "+" : ""}$${effect.delta.toLocaleString()} → balance $${effect.balance.toLocaleString()} (virtual).`);
        break;
      case "grant": {
        const held = this.#granted.get(effect.did) ?? [];
        if (!held.includes(effect.namespace)) held.push(effect.namespace);
        this.#granted.set(effect.did, held);
        // The only power that touches agents directly. Agents listen for this event and
        // unlock the tool.
        emitSilent(bot.client, ch, "foundry_grant", {
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

  /**
   * Run the acceptance check against the canonical tree.
   *
   * The same sandbox the agents use, but on the repository everyone actually shares,
   * executed by the party with no stake in the answer.
   */
  async #verifyRepo(): Promise<{ ok: boolean; detail: string }> {
    const files = new Map<string, string>();
    for (const path of listRepo(this.#options.workspace)) {
      if (!/\.(mjs|js|json)$/.test(path)) continue;
      try {
        files.set(path, readFileSync(join(this.#options.workspace, path), "utf8"));
      } catch {
        // A file that vanished mid-verification simply is not part of the tree.
      }
    }
    if (![...files.keys()].some((p) => p.startsWith("src/") && p.endsWith(".mjs"))) {
      return { ok: false, detail: "no modules under src/ in the shared repository" };
    }
    files.set("__verify__.mjs", VERIFY_SCRIPT);
    const result = await this.#sandbox.run({ files, entryPoint: "__verify__.mjs" });
    return {
      ok: result.outcome === "succeeded",
      detail: `${result.outcome}: ${(result.stdout + result.stderr).trim().slice(0, 300)}`,
    };
  }

  /** Compact state broadcast so every agent's next turn starts from the same facts. */
  async #broadcastState(): Promise<void> {
    const bot = this.#bot;
    if (bot === undefined) return;
    emitSilentSized(bot.client, this.#options.channel, "foundry_state", {
      ...this.#publicState(),
      // Every participant's own position, keyed by DID, so no client has to derive it.
      // All of it is public anyway: votes and equity are announced as they happen.
      you: Object.fromEntries(
        [...this.#participants.keys()].map((did) => [did, this.#standingFor(did)]),
      ),
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
    for (const [did, participant] of this.#participants) {
      const nick = participant.nick;
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
