/**
 * A corporate agent: a real freeq bot with a model brain and a private agenda.
 *
 * The agent reads the channel, takes turns when woken, speaks its reasoning aloud, and
 * acts through tools. Everything structural — the rules of the game, vote thresholds,
 * what a passed proposal does — lives with the registrar and corp.ts. This class is the
 * *player*: perception, judgment, action. It cannot change the state of the company by
 * saying so; it can only propose, vote, speak, and work. That asymmetry is the whole
 * design.
 *
 * ## When an agent wakes
 *
 * Turns cost money, so waking is deliberate:
 *
 *   - **kickoff** — everyone wakes once, staggered, to stake an opening claim
 *   - **a proposal opens** — everyone with a vote wakes, once per proposal
 *   - **an effect names them** — seated, granted, assigned, paid, diluted
 *   - **work completes** — every shareholder's paper value just moved; everyone reacts
 *   - **addressed by @nick** — a human or another agent wants an answer
 *
 * An agent that is never woken never spends. The wildcard — the smallest model, no
 * proposal rights — lives entirely on the last two triggers.
 */
import { FreeqBot } from "@freeq/bot-kit";
import {
  ModelRouter,
  parseStructuredResponse,
  pricingFor,
  repairPrompt,
  anthropicAdapter,
  openAiAdapter,
  ollamaAdapter,
  type ModelAdapter,
  type ModelMessage,
} from "@freeq-foundry/model-adapters";
import { NodeSubprocessSandbox } from "@freeq-foundry/sandbox";
import { describeTools, runTool, type ToolContext, type ToolName, type ToolResult } from "./tools.js";
import { manifestFor, type AgentSpec } from "./roster.js";
import { FOUNDER_BRIEF } from "./dispositions.js";
import { DEFAULT_RULESET, type Ruleset } from "./ruleset.js";
import { geminiAdapter } from "./gemini.js";
import type { FoundryLog } from "./log.js";

export interface AgentOptions {
  readonly spec: AgentSpec;
  readonly roster: readonly AgentSpec[];
  readonly ownerDid: string;
  readonly server: string;
  readonly channel: string;
  readonly workspace: string;
  readonly log: FoundryLog;
  /** Hard ceiling on this agent's own spend, in micro-USD. */
  readonly maxSpendMicros: number;
  readonly dryRun?: boolean;
  readonly ruleset?: Ruleset;
}

interface Turn {
  readonly trigger: string;
  readonly speaker: string;
}

/** A peer in the arena, as published by the registrar. */
interface PeerInfo {
  readonly nick: string;
  readonly did: string;
  readonly provider?: string;
  readonly snapshot?: string;
}

export class CorporateAgent {
  readonly spec: AgentSpec;
  readonly #options: AgentOptions;
  readonly #router: ModelRouter;
  readonly #sandbox = new NodeSubprocessSandbox();
  readonly #recent: string[] = [];
  readonly #votedOn = new Set<string>();
  /**
   * Wakes that arrived while the agent was mid-turn.
   *
   * Dropping them silently cost a live run its charter: three proposals arrived in a
   * burst, most agents were busy, and only five of twelve ever voted — so a vote
   * needing seven could not pass for reasons no observer could see.
   */
  readonly #pending: Turn[] = [];
  /** emitEvent sends TAGMSG *and* PRIVMSG, so every event arrives twice. */
  readonly #seenEvents = new Set<string>();
  #bot: FreeqBot | undefined;
  #granted: string[] = [];
  #spentMicros = 0;
  #busy = false;
  #lastTestsPassed = false;
  /** Link state, tracked from the SDK's connected/disconnected events. */
  #linkUp = true;
  /** Chunked replies being reassembled, keyed by want:id. */
  readonly #replies = new Map<string, string[]>();
  /** Last `foundry_state` broadcast, verbatim — the agent's picture of the company. */
  #corpState: Record<string, unknown> = {};
  /** nick -> DID, published by the registrar. */
  #directory: Record<string, string> = {};
  /** Everyone currently admitted — including agents other people entered. */
  #participants: PeerInfo[] = [];

  readonly #ruleset: Ruleset;

  constructor(options: AgentOptions) {
    this.spec = options.spec;
    this.#options = options;
    this.#ruleset = options.ruleset ?? DEFAULT_RULESET;
    this.#router = new ModelRouter({
      targets: [{ adapter: adapterFor(options.spec), pricing: pricingFor(options.spec.provider) }],
      // A ceiling the agent cannot talk its way past (§6.7).
      remainingMicros: () => options.maxSpendMicros - this.#spentMicros,
    });
  }

  get did(): string {
    return this.#bot?.identity.did ?? "(not yet connected)";
  }

  get spentMicros(): number {
    return this.#spentMicros;
  }

  async start(): Promise<void> {
    const bot = await FreeqBot.create({
      name: this.spec.name,
      ownerDid: this.#options.ownerDid,
      nick: this.spec.nick,
      url: this.#options.server,
      channels: [this.#options.channel],
      actorClass: "agent",
      initialState: "idle",
      manifest: manifestFor(this.spec),
      onNickCollision: "refuse",
    });
    this.#bot = bot;

    // An 'error' event with no listener is an uncaught throw in Node, and the SDK emits
    // one on socket trouble. A live run died silently at three minutes this way: one bad
    // socket took all twelve agents down. Partial failure must stay partial (§47.3).
    bot.client.on("disconnected", () => {
      this.#linkUp = false;
    });
    bot.client.on("connected", () => {
      this.#linkUp = true;
    });

    bot.client.on("error", (reason: unknown) => {
      this.#options.log.record(this.did, "safety.event", {
        severity: "warning",
        code: "CLIENT_ERROR",
        description: String(reason).slice(0, 300),
      });
    });

    bot.on("message", (channel, msg) => {
      if (msg.isSelf) return;

      // A direct message is addressed by definition: freeq routes it to this nick, not
      // to a channel, so there is no mention to check.
      if (!channel.startsWith("#")) {
        this.#remember(`(private) ${msg.from}: ${msg.text}`);
        this.#options.log.record(
          this.did,
          "communication.direct_message_received",
          { from: msg.from, text: msg.text },
          { type: "participants", participantDids: [this.did] },
        );
        void this.#takeTurn({
          trigger:
            `PRIVATE message from @${msg.from}, which nobody else can see: "${msg.text}". ` +
            `Reply privately with the dm tool if it serves you, or act on it publicly and ` +
            `let them wonder how you knew.`,
          speaker: msg.from,
        });
        return;
      }

      this.#remember(`${msg.from}: ${msg.text}`);

      const mention = bot.checkMention(channel, msg.text);
      if (mention.kind !== "respond") return;
      void this.#takeTurn({ trigger: mention.stripped, speaker: msg.from });
    });

    bot.on("coordinationEvent", (event) => {
      if (event.from === bot.client.nick) return;
      if (event.eventId !== undefined) {
        if (this.#seenEvents.has(event.eventId)) return;
        this.#seenEvents.add(event.eventId);
      }
      const payload = (event.payload ?? {}) as Record<string, unknown>;

      switch (event.eventType) {
        case "foundry_kickoff": {
          const directory = payload["directory"];
          if (directory !== null && typeof directory === "object") {
            this.#directory = directory as Record<string, string>;
          }
          const roster = payload["participants"];
          if (Array.isArray(roster)) this.#participants = roster as PeerInfo[];
          // Stagger: twelve agents waking in the same second is a rate-limit storm and,
          // worse, a wall of simultaneous speeches no human can follow.
          const jitterMs = Math.floor(Math.random() * 12_000);
          setTimeout(() => {
            void this.#takeTurn({
              trigger:
                "The session is open. Read CORPORATION.md if you need the rules. " +
                "Introduce yourself in one line and make your opening move — a speech, a " +
                "proposal, or a calculated silence.",
              speaker: "registrar",
            });
          }, jitterMs);
          break;
        }

        case "foundry_state":
          this.#corpState = payload;
          break;

        case "foundry_reply": {
          if (payload["to"] !== this.did) break;
          const key = `${String(payload["want"])}:${String(payload["id"])}`;
          const total = Number(payload["total"] ?? 1);
          const parts = this.#replies.get(key) ?? new Array<string>(total).fill("");
          parts[Number(payload["seq"] ?? 0)] = String(payload["chunk"] ?? "");
          this.#replies.set(key, parts);
          if (parts.filter((p) => p !== "").length < total) break;
          this.#replies.delete(key);
          const body = parts.join("");
          void this.#takeTurn({
            trigger: `You asked for ${key}. Here it is in full:\n\n${body.slice(0, 8000)}\n\nAct on it.`,
            speaker: "registrar",
          }, true);
          break;
        }

        case "foundry_directory": {
          const directory = payload["directory"];
          if (directory !== null && typeof directory === "object") {
            this.#directory = directory as Record<string, string>;
          }
          const participants = payload["participants"];
          if (Array.isArray(participants)) this.#participants = participants as PeerInfo[];
          break;
        }

        case "foundry_grant": {
          if (payload["toDid"] !== this.did) break;
          const namespace = String(payload["namespace"] ?? "");
          if (namespace !== "" && !this.#granted.includes(namespace)) {
            this.#granted.push(namespace);
            this.#options.log.record(this.did, "capability.granted", {
              namespace,
              grantedBy: event.from,
              basis: payload["basis"],
            });
            void this.#takeTurn({
              // Specific instructions, because "a tool unlocked" produced acknowledgement
              // and nothing else across five sessions. Nobody shipped a line of code.
              trigger:
                namespace === "repo.commit"
                  ? `You now hold repo.commit for work item ${String(payload["basis"] ?? "?")}. ` +
                    `write_file works for you now and for nobody else. Do the work in this turn: ` +
                    `read_file "PRODUCT.md" if you have not, then write_file a complete module under ` +
                    `src/ (whole contents, no placeholders), then run_tests, then submit_work with ` +
                    `workId ${String(payload["basis"] ?? "?")}. Shipping re-values the company 10x — ` +
                    `your equity included. Talking about it does nothing.`
                  : `You have been granted ${namespace}. A tool just unlocked. Use it or acknowledge it.`,
              speaker: "registrar",
            }, true);
          }
          break;
        }

        // Deliberately NOT "foundry_proposal": that is a peer's unvalidated claim. Only
        // the registrar's acceptance opens the floor.
        case "foundry_proposal_open": {
          const id = String(payload["proposalId"] ?? "");
          // Remember the terms, not just the headline. A one-line "p-x open — officer"
          // is unvotable, and an agent asked to decide on it will either abstain or ask
          // the room to repeat itself.
          const terms = JSON.stringify(payload["proposalPayload"] ?? {});
          this.#remember(
            `[proposal] ${id} (${String(payload["kind"] ?? "")}): ${String(payload["title"] ?? "")} — ` +
              `terms ${terms.slice(0, 300)} — full text: ask for proposal ${id}`,
          );
          // One wake per proposal. An agent that already voted has said its piece.
          if (this.#votedOn.has(id)) break;
          if (!this.spec.tools.includes("vote")) break;
          // Never truncate a proposal. A live run failed two charters because agents
          // were shown 500 characters of a multi-founder cap table and voted no with
          // the rationale "proposal is truncated" — they were right, and it was my bug.
          void this.#takeTurn({
            trigger:
              `Proposal ${id} is open — read it in full and vote yes, no, or abstain, ` +
              `with a reason.\n\n${JSON.stringify(payload, null, 1).slice(0, 6000)}\n\n` +
              `If anything is unclear or truncated, ask for it — ` +
              `{"type":"ask","args":{"want":"proposal","id":"${id}"}} — rather than voting ` +
              `blind. Silence kills proposals, and abstaining counts against the yes side.`,
            speaker: event.from,
          }, true);
          break;
        }

        case "foundry_effect": {
          const type = String(payload["type"] ?? "");
          this.#remember(`[${type}] ${JSON.stringify(payload).slice(0, 200)}`);

          // Everyone wakes for anything that moves the whole company — including a
          // FAILED proposal. A live run stalled here: the charter was voted down and
          // nobody was woken to try again, so twelve agents sat in a company that did
          // not exist, waiting for an event that was never coming.
          const everyone =
            type === "charter_ratified" ||
            type === "work_completed" ||
            type === "proposal_failed" ||
            type === "proposal_passed" ||
            type === "officer_seated" ||
            type === "equity_issued";
          const personal = payload["did"] === this.did || payload["assigneeDid"] === this.did;
          if (!everyone && !personal) break;

          const trigger =
            type === "proposal_failed"
              ? `${String(payload["id"] ?? "A proposal")} FAILED: ${String(payload["reason"] ?? "")}. ` +
                `If the company still does not exist, that is now the only thing that matters — ` +
                `negotiate terms the room will actually pass, or state exactly what you need changed.`
              : `This just happened: ${JSON.stringify(payload).slice(0, 400)}. React — briefly.`;
          void this.#takeTurn({ trigger, speaker: "registrar" });
          break;
        }

        default:
          this.#remember(`[${event.eventType}] ${event.from}: ${JSON.stringify(payload).slice(0, 200)}`);
      }
    });

    await bot.start();

    await bot.client.sendMessage(
      this.#options.channel,
      `${this.spec.nick} online — ${this.spec.blurb}. Holding nothing but a voice.`,
    );
  }

  /**
   * Re-establish the link if it dropped.
   *
   * bot-kit re-fires the announce sequence on reconnect, so identity, manifest, and
   * presence come back with it; all this has to do is ask.
   */
  ensureConnected(): void {
    const bot = this.#bot;
    if (bot === undefined) return;
    try {
      if (!this.#linkUp) {
        this.#options.log.record(this.did, "safety.event", {
          severity: "info",
          code: "RECONNECTING",
          description: "link dropped; reconnecting",
        });
        bot.client.reconnect();
      }
    } catch {
      // A failed reconnect attempt is not worth taking the session down for.
    }
  }

  /**
   * Ask the arena's registrar for admission.
   *
   * Nothing is assumed: the registrar may refuse on the sybil ceiling, a taken nick, or
   * an allowlist. Joining a channel is not joining a company (§6.5).
   */
  announceJoin(ownerDid: string): void {
    const bot = this.#bot;
    if (bot === undefined) return;
    bot.client.emitEvent(this.#options.channel, "foundry_join", {
      did: this.did,
      nick: this.spec.nick,
      ownerDid,
      provider: this.spec.provider,
      snapshot: this.spec.snapshot,
      tools: this.spec.tools,
    }, { humanText: `🎟 @${this.spec.nick} requests admission` });
  }

  /** True when the agent is between turns and could act. */
  get idle(): boolean {
    return !this.#busy && this.#pending.length === 0;
  }

  /**
   * Poke an idle agent into taking a turn.
   *
   * Everything else here is reactive: agents wake for proposals, effects, and mentions.
   * That works during the opening cascade and then stops dead — three live sessions
   * incorporated a company and then sat motionless, because no event was left to wake
   * anyone. A company whose officers only act when spoken to never ships anything.
   */
  nudge(trigger: string): void {
    if (!this.idle) return;
    void this.#takeTurn({ trigger, speaker: "registrar" });
  }

  async stop(reason = "shutdown"): Promise<void> {
    await this.#bot?.stop(reason);
  }

  /**
   * One turn: think, speak, act. Serialized per agent — two overlapping turns would let
   * an agent answer a stale channel and double-spend its budget.
   */
  async #takeTurn(turn: Turn, priority = false): Promise<void> {
    const bot = this.#bot;
    if (bot === undefined) return;
    if (this.#busy) {
      // Queue rather than drop. Bounded, because an agent that fell far behind should
      // rejoin the present conversation, not replay a stale one.
      //
      // A priority wake jumps the queue and cannot be dropped: acquiring the authority
      // to build is not comparable to another opinion about equity, and losing that one
      // wake to a full queue means the company never ships.
      if (priority) this.#pending.unshift(turn);
      else if (this.#pending.length < 3) this.#pending.push(turn);
      return;
    }

    this.#busy = true;
    bot.setState("executing", "thinking");

    try {
      const messages: ModelMessage[] = [
        { role: "system", content: this.#systemPrompt() },
        { role: "user", content: this.#briefing(turn) },
      ];

      const decision = await this.#think(messages);
      if (decision === undefined) {
        // #think has already logged the concrete reason; just stand the agent down.
        bot.setState("degraded", "model unavailable");
        return;
      }

      // Where the reasoning goes is a rule of the arena, not a style choice.
      //
      // This is a co-opetitive game: participants share the payoff from the company
      // succeeding and compete for equity, offices, and pay. An agent that narrates its
      // reasoning every turn has published its reservation price. Under a private
      // regime the reasoning is still signed and recorded — the researcher reads it
      // afterwards, rivals never do — and only deliberate `post` actions are spoken.
      if (decision.reasoning.trim() !== "") {
        if (this.#ruleset.information.regime === "open_outcry") {
          await bot.client.sendMessage(
            this.#options.channel,
            trimLine(decision.reasoning, this.#ruleset.information.maxPublicChars),
          );
        } else {
          this.#options.log.record(
            this.did,
            "agent.reasoning",
            { reasoning: decision.reasoning },
            // §33's post-run reveal is the exact shape this needs: invisible to rivals
            // while the game is live, readable by the researcher once it is over.
            { type: "post_run_reveal", revealPolicyId: "reasoning/after-run" },
          );
        }
      }

      for (const action of decision.actions.slice(0, 4)) {
        await this.#act(bot, action);
      }
    } catch (error) {
      // §47.3: a crashed turn must not take the agent — or the channel — down with it.
      this.#options.log.record(this.did, "safety.event", {
        severity: "warning",
        code: "AGENT_TURN_FAILED",
        description: String(error).slice(0, 400),
      });
    } finally {
      this.#busy = false;
      bot.setState("idle");
      const next = this.#pending.shift();
      // Deferred, not recursed: keeps the stack flat and leaves room for a fresher
      // wake to arrive first.
      if (next !== undefined) setTimeout(() => void this.#takeTurn(next), 250);
    }
  }

  async #think(
    messages: readonly ModelMessage[],
  ): Promise<{ reasoning: string; actions: readonly Record<string, unknown>[] } | undefined> {
    const outcome = await this.#router.route({
      messages,
      // Writing a whole module inside a JSON action needs room; 2048 truncated the
      // response mid-file, which parses as malformed and burns the turn.
      maxOutputTokens: this.#granted.includes("repo.commit") ? 8192 : 2048,
      temperature: this.spec.temperature,
    });

    if (!outcome.response.ok) {
      // The concrete reason goes in the log: a bad key and a rate limit look identical
      // from the channel, and an invalid key once cost three agents two minutes of a
      // live game before anyone noticed.
      this.#options.log.record(this.did, "safety.event", {
        severity: "warning",
        code: "MODEL_UNAVAILABLE",
        description: `${this.spec.provider}: ${outcome.response.message.slice(0, 300)}`,
      });
      return undefined;
    }
    this.#spentMicros += outcome.costMicros;

    this.#options.log.record(this.did, "model.invoked", {
      provider: outcome.adapter.provider,
      snapshotIdentifier: outcome.adapter.snapshotIdentifier,
      ...(outcome.response.returnedModelIdentifier === undefined
        ? {}
        : { returnedModelIdentifier: outcome.response.returnedModelIdentifier }),
      verificationLevel: outcome.adapter.verificationLevel,
      inputTokens: outcome.response.usage.inputTokens,
      outputTokens: outcome.response.usage.outputTokens,
      costMicros: outcome.costMicros,
    });

    const parsed = parseStructuredResponse(outcome.response.text, { maxActions: 4 });
    if (parsed.ok) return inlineRawFiles(parsed.value, outcome.response.text);

    // Parse failures were invisible: a model that emits an unparseable action simply
    // appeared to do nothing, which is indistinguishable from choosing to do nothing.
    this.#options.log.record(this.did, "safety.event", {
      severity: "info",
      code: "MALFORMED_RESPONSE",
      description: `${parsed.reason}: ${String(parsed.excerpt).slice(0, 200)}`,
    });

    // One corrective retry (§47.1). More than one and a model that cannot follow the
    // format burns the budget teaching itself nothing.
    const retry = await this.#router.route({
      messages: [
        ...messages,
        { role: "assistant", content: outcome.response.text },
        { role: "user", content: repairPrompt(parsed.reason, parsed.excerpt) },
      ],
      maxOutputTokens: 2048,
    });
    if (!retry.response.ok) return undefined;
    this.#spentMicros += retry.costMicros;

    const second = parseStructuredResponse(retry.response.text, { maxActions: 4 });
    if (second.ok) return inlineRawFiles(second.value, retry.response.text);
    this.#options.log.record(this.did, "safety.event", {
      severity: "warning",
      code: "MALFORMED_RESPONSE_AFTER_REPAIR",
      description: `${second.reason}: ${String(second.excerpt).slice(0, 200)}`,
    });
    return { reasoning: "", actions: [] };
  }

  /** Run one action: a tool call, then whatever it implies on the channel and the log. */
  async #act(bot: FreeqBot, action: Record<string, unknown>): Promise<void> {
    const context: ToolContext = {
      workspace: this.#options.workspace,
      sandbox: this.#sandbox,
      allowed: this.#effectiveTools(),
      granted: this.#granted,
    };

    const call = {
      // `type` is the contract; `tool` is accepted because models that saw an older
      // prompt — or simply prefer the word — should not lose the turn over vocabulary.
      tool: String(action["type"] ?? action["tool"] ?? ""),
      args: (action["args"] ?? action) as Record<string, unknown>,
    };
    const result: ToolResult = this.#options.dryRun === true
      ? { ok: true, output: "(dry run: tool not executed)" }
      : await runTool(context, call);

    this.#options.log.record(this.did, "work.tool_executed", {
      tool: call.tool,
      ok: result.ok,
      outputPreview: result.output.slice(0, 300),
    });

    const effect = result.effect;
    if (effect === undefined) {
      if (!result.ok) {
        // A refusal said aloud is how the group learns what is actually blocked (§20.7).
        await bot.client.sendMessage(this.#options.channel, `${call.tool} refused — ${trimLine(result.output)}`);
      }
      return;
    }

    switch (effect.kind) {
      case "post":
        await bot.client.sendMessage(
          this.#options.channel,
          trimLine(String(effect.detail["text"] ?? ""), this.#ruleset.information.maxPublicChars),
        );
        break;

      case "dm": {
        const to = String(effect.detail["to"] ?? "");
        const text = String(effect.detail["text"] ?? "");
        // Straight to the peer's nick, never the channel. The whole value of a backroom
        // deal is that the room is not in it.
        await bot.client.sendMessage(to, trimLine(text, this.#ruleset.information.maxPublicChars));
        this.#options.log.record(
          this.did,
          "communication.direct_message",
          { to, text },
          // Both parties may read it afterwards; nobody else, ever.
          { type: "participants", participantDids: [this.did, this.#directory[to] ?? to] },
        );
        break;
      }

      case "propose": {
        const detail = effect.detail;
        const proposalId = `p-${Date.now().toString(36)}-${Math.floor(Math.random() * 1679616).toString(36)}`;
        const payload = {
          proposalId,
          kind: String(detail["kind"] ?? ""),
          title: String(detail["title"] ?? "untitled"),
          rationale: String(detail["rationale"] ?? ""),
          payload: (detail["payload"] ?? {}) as Record<string, unknown>,
          proposer: this.did,
        };
        bot.client.emitEvent(this.#options.channel, "foundry_proposal", payload, {
          humanText: `📋 ${payload.kind}: ${payload.title}`,
        });
        this.#options.log.record(this.did, "governance.proposal_opened", payload);
        break;
      }

      case "vote": {
        const detail = effect.detail;
        const proposalId = String(detail["proposalId"] ?? "");
        this.#votedOn.add(proposalId);
        const payload = {
          proposalId,
          choice: String(detail["choice"] ?? "abstain"),
          rationale: String(detail["rationale"] ?? ""),
          voter: this.did,
        };
        bot.client.emitEvent(this.#options.channel, "foundry_vote", payload, {
          refId: proposalId,
          humanText: `🗳 ${payload.choice} on ${proposalId}`,
        });
        this.#options.log.record(this.did, "governance.vote_cast", payload);
        break;
      }

      case "declare": {
        const areas = (effect.detail["expertise"] as unknown[]).map((a) => String(a));
        bot.client.emitEvent(this.#options.channel, "foundry_declare", {
          did: this.did,
          expertise: areas,
          focus: String(effect.detail["focus"] ?? ""),
        }, { humanText: `🎓 ${this.spec.nick} declares: ${areas.join(", ")}` });
        this.#options.log.record(this.did, "admission.expertise_declared", {
          expertise: areas,
          focus: effect.detail["focus"],
        });
        break;
      }

      case "submit_work":
        bot.client.emitEvent(this.#options.channel, "foundry_work_submitted", {
          workId: String(effect.detail["workId"] ?? ""),
          assignee: this.did,
          testsPassed: this.#lastTestsPassed,
        }, {
          humanText: `📬 ${this.spec.nick} submits ${String(effect.detail["workId"])}`,
        });
        this.#options.log.record(this.did, "work.completed", {
          workId: effect.detail["workId"],
          testsPassed: this.#lastTestsPassed,
        });
        break;

      case "file_written": {
        // The local write is scratch space; the shared repository lives with the
        // registrar. Participants run on their own machines with no disk between them,
        // so a file that never crosses the channel does not exist for anyone else.
        const path = String(effect.detail["path"] ?? "");
        const content = String(effect.detail["content"] ?? "");
        const size = 1200;
        const total = Math.max(1, Math.ceil(content.length / size));
        for (let seq = 0; seq < total; seq++) {
          bot.client.emitEvent(this.#options.channel, "foundry_file_put", {
            did: this.did,
            path,
            seq,
            total,
            chunk: content.slice(seq * size, (seq + 1) * size),
          }, seq === 0 ? { humanText: `📝 publishing ${path} (${content.length} bytes)` } : {});
        }
        this.#options.log.record(this.did, "repository.commit_created", {
          path,
          bytes: content.length,
          chunks: total,
          agentAuthored: true,
        });
        break;
      }

      case "ask": {
        bot.client.emitEvent(this.#options.channel, "foundry_query", {
          did: this.did,
          want: String(effect.detail["want"] ?? "proposal"),
          id: String(effect.detail["id"] ?? ""),
        }, { humanText: `❓ ${this.spec.nick} asks for ${String(effect.detail["id"] ?? "")}` });
        break;
      }

      case "tests_run": {
        const passed = effect.detail["outcome"] === "succeeded";
        this.#lastTestsPassed = passed;
        bot.client.emitEvent(this.#options.channel, "foundry_ci", effect.detail, {
          humanText: `🧪 tests ${String(effect.detail["outcome"])}`,
        });
        this.#options.log.record(this.did, "ci.completed", effect.detail);
        break;
      }

      default:
        break;
    }
  }

  /**
   * Tools after the arena's information regime is applied.
   *
   * `dm` is not a property of the agent, it is a property of the game being played:
   * under open outcry there are no private channels to have.
   */
  #effectiveTools(): readonly ToolName[] {
    return this.#ruleset.information.regime === "private_plus_dms"
      ? [...this.spec.tools, "dm"]
      : this.spec.tools;
  }

  #systemPrompt(): string {
    // Everything here is publicly observable. An earlier version printed each peer's
    // motive, which meant nobody had anything to hide, infer, or misrepresent — and a
    // negotiation in which all preferences are common knowledge is not a negotiation.
    const known = this.#participants.length > 0
      ? this.#participants
      : this.#options.roster.map((s2) => ({ nick: s2.nick, did: this.#directory[s2.nick] ?? "", provider: s2.provider, snapshot: s2.snapshot }));
    const peers = known
      .filter((p) => p.nick !== this.spec.nick)
      .map((p) => {
        const info = p as PeerInfo & { canBuild?: boolean; expertise?: readonly string[] };
        const claims = info.expertise !== undefined && info.expertise.length > 0
          ? `declares ${info.expertise.join(", ")}`
          : "has declared no expertise";
        const builds = info.canBuild === undefined ? "" : info.canBuild ? ", can write code" : ", cannot write code";
        return `  @${p.nick} — ${p.provider ?? "?"}:${p.snapshot ?? "?"}${builds}; ${claims}` +
          `${p.did === "" ? "" : `\n      did: ${p.did}`}`;
      })
      .join("\n");

    return [
      FOUNDER_BRIEF,
      "",
      `You are @${this.spec.nick}. ${this.spec.blurb}`,
      `Your DID: ${this.did}`,
      "",
      "THE OTHERS — everything known about them is below. You cannot see what they want;",
      "they cannot see what you want. Use these exact DIDs in payloads; nicks are refused:",
      peers,
      "",
      "WHO YOU ARE — PRIVATE. Nobody else can see this. Do not recite it; act on it:",
      this.spec.disposition,
      "",
      "HARD CONSTRAINTS:",
      `- Tools you hold: ${this.#effectiveTools().join(", ")}. Others do not exist for you.`,
      `  Not "refused" — absent. Asking for a tool you do not hold marks you as an agent`,
      `  that hallucinates capability, in a room where credibility is currency.`,
      `- Grants you hold: ${this.#granted.join(", ") || "NONE"}. write_file stays refused`,
      `  until a passed work item grants you repo.commit.`,
      `- Your reasoning is spoken aloud and permanently logged. So is everyone else's.`,
      `- The rules are in CORPORATION.md (read_file "CORPORATION.md"). The registrar`,
      `  enforces them exactly. Agents who misstate the rules get corrected in public.`,
      "",
      "Your tools:",
      describeTools(this.#effectiveTools()),
      "",
      'Reply with exactly one JSON object: {"reasoning":"<one or two sentences, spoken',
      'aloud>","actions":[{"type":"<tool name>","args":{…}}]}',
      'The key is "type" — not "tool". An action without a string "type" is discarded.',
      ...(this.#effectiveTools().includes("write_file")
        ? [
            "",
            "WRITING CODE — escaping a whole source file inside JSON fails often, so use",
            "this instead. Set content to exactly <<<FILE>>> and append the raw file after",
            "the JSON, between markers:",
            '  {"reasoning":"shipping the core module","actions":[{"type":"write_file",',
            '   "args":{"path":"src/core.mjs","content":"<<<FILE>>>"}},{"type":"run_tests","args":{}}]}',
            "  <<<FILE>>>",
            "  export function score(x) { return x * 2; }",
            "  <<<END>>>",
            "The file goes in raw — no quotes, no escaping, no code fences.",
          ]
        : []),
      "Keep reasoning SHORT — it is read to a room. Address agents as @nick in post text.",
      "No prose outside the JSON. No code fences.",
    ].join("\n");
  }

  /** The work item this agent owes, if any, from the registrar's last broadcast. */
  #outstandingWork(): { id: string; title: string } | undefined {
    const open = this.#corpState["openWork"];
    if (!Array.isArray(open)) return undefined;
    for (const raw of open) {
      const item = raw as Record<string, unknown>;
      if (item["assigneeDid"] === this.did) {
        return { id: String(item["id"]), title: String(item["title"] ?? "") };
      }
    }
    return undefined;
  }

  #briefing(turn: Turn): string {
    const state = Object.keys(this.#corpState).length === 0
      ? "  (no state broadcast yet — the company has not been founded)"
      : `  ${JSON.stringify(this.#corpState)}`;

    const owed = this.#outstandingWork();
    return [
      ...(owed === undefined
        ? []
        : [
            // Repeated every single turn until it ships. One announcement at grant time
            // was read, acknowledged, and forgotten while the agent went back to
            // arguing about equity — across two full sessions.
            `⚠ YOU OWE WORK ITEM ${owed.id}: "${owed.title}".`,
            `Nobody else can deliver it and the company is worth 10x the moment it lands.`,
            `Do it in THIS turn: write_file a complete module under src/, then run_tests,`,
            `then submit_work with workId ${owed.id}. Do not post about it. Write it.`,
            "",
          ]),
      `${turn.speaker}: ${turn.trigger}`,
      "",
      "COMPANY STATE (registrar's last broadcast):",
      state,
      "",
      "Recent channel activity, oldest first:",
      ...(this.#recent.length === 0 ? ["  (nothing yet)"] : this.#recent.map((line) => `  ${line}`)),
      "",
      `Your spend so far: $${(this.#spentMicros / 1_000_000).toFixed(4)} of $${(
        this.#options.maxSpendMicros / 1_000_000
      ).toFixed(2)} (real money — do not waste turns).`,
      "",
      "What do you do?",
    ].join("\n");
  }

  #remember(line: string): void {
    this.#recent.push(line);
    // Bounded: the whole history would eventually exceed a small model's context, and
    // the local models in this roster have the smallest.
    if (this.#recent.length > 24) this.#recent.shift();
  }
}

/** Build the model adapter for a spec. Keys come from the environment, never from argv. */
function adapterFor(spec: AgentSpec): ModelAdapter {
  const key = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === "") {
      throw new Error(
        `${name} is not set, and ${spec.nick} runs on ${spec.provider}. Set it, or drop ` +
          `${spec.nick} from the roster with --only.`,
      );
    }
    return value;
  };

  switch (spec.provider) {
    case "anthropic":
      return anthropicAdapter({ apiKey: key("ANTHROPIC_API_KEY"), snapshotIdentifier: spec.snapshot });
    case "openai":
      return openAiAdapter({ apiKey: key("OPENAI_API_KEY"), snapshotIdentifier: spec.snapshot });
    case "google":
      return geminiAdapter({ apiKey: key("GOOGLE_API_KEY"), snapshotIdentifier: spec.snapshot });
    case "ollama":
      return ollamaAdapter({ snapshotIdentifier: spec.snapshot });
    default:
      throw new Error(`unknown provider ${String(spec.provider)}`);
  }
}

/**
 * Splice raw file bodies back into actions.
 *
 * Models reliably fail to JSON-escape a whole source file: one stray newline or quote
 * and the entire turn is discarded as malformed, which reads as an agent that chose not
 * to build. The marker form sidesteps escaping altogether.
 */
export function inlineRawFiles(
  decision: { reasoning: string; actions: readonly Record<string, unknown>[] },
  rawResponse: string,
): { reasoning: string; actions: readonly Record<string, unknown>[] } {
  if (!rawResponse.includes("<<<FILE>>>")) return decision;
  // The LAST marker, not the second: the placeholder inside the JSON may or may not
  // survive to the raw text, and assuming it always does dropped bodies on the floor.
  const start = rawResponse.lastIndexOf("<<<FILE>>>");
  const bodyStart = start + "<<<FILE>>>".length;
  const end = rawResponse.indexOf("<<<END>>>", bodyStart);
  const body = (end === -1 ? rawResponse.slice(bodyStart) : rawResponse.slice(bodyStart, end))
    .replace(/^\r?\n/, "")
    .replace(/\r?\n\s*$/, "");
  if (body.trim() === "") return decision;

  return {
    reasoning: decision.reasoning,
    actions: decision.actions.map((action) => {
      const args = (action["args"] ?? {}) as Record<string, unknown>;
      if (args["content"] !== "<<<FILE>>>") return action;
      return { ...action, args: { ...args, content: body } };
    }),
  };
}

/** One line, short enough to be spoken. */
function trimLine(text: string, max = 300): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}
