/**
 * A Foundry agent that lives on the freeq network.
 *
 * ## How the two protocols fit together
 *
 * freeq is the substrate; Foundry is the protocol spoken on it. The mapping is close
 * enough to be worth stating, because most of the identity work is already done:
 *
 * | Foundry | freeq |
 * |---|---|
 * | participant DID | the bot's `did:key`, persisted by bot-kit |
 * | agent creation credential | `FreeqBotDelegation/v1`, signed by the owner |
 * | provenance chain to a human root | `PROVENANCE` + the owner's `did:plc:` |
 * | declared capabilities | `AGENT MANIFEST` |
 * | **granted** capabilities | nothing in freeq — governance decides, in channel |
 * | actions | coordination events (`TAGMSG`) |
 * | the log | the channel, plus a local signed event log |
 *
 * That last distinction is the load-bearing one. freeq will happily let an agent
 * announce `repo.commit` in its manifest. Foundry refuses to let it act on that until a
 * proposal has passed, and this class enforces the gap rather than papering over it —
 * §6.5 exists precisely because a declared capability is not an authority.
 *
 * ## Why the channel is the coordination medium
 *
 * A human can read it. §38.1 wants an observer able to explain a decision from human
 * root to result, and a channel a person can scroll is a better observer than any
 * dashboard I could build. The signed local log is what makes it *verifiable*; the
 * channel is what makes it *legible*.
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
import { describeTools, runTool, type ToolContext, type ToolResult } from "./tools.js";
import { manifestFor, type AgentSpec } from "./roster.js";
import { geminiAdapter } from "./gemini.js";
import type { FoundryLog } from "./log.js";

export interface AgentOptions {
  readonly spec: AgentSpec;
  readonly ownerDid: string;
  readonly server: string;
  readonly channel: string;
  readonly workspace: string;
  readonly specPath: string;
  readonly log: FoundryLog;
  /** Hard ceiling on this agent's own spend, in micro-USD. */
  readonly maxSpendMicros: number;
  readonly dryRun?: boolean;
}

/** What the agent knows. Assembled fresh each turn from the channel and the log. */
interface Turn {
  readonly trigger: string;
  readonly speaker: string;
  readonly recent: readonly string[];
}

export class FoundryFreeqAgent {
  readonly spec: AgentSpec;
  readonly #options: AgentOptions;
  readonly #router: ModelRouter;
  readonly #sandbox = new NodeSubprocessSandbox();
  readonly #recent: string[] = [];
  #bot: FreeqBot | undefined;
  #granted: string[] = [];
  #spentMicros = 0;
  #busy = false;

  constructor(options: AgentOptions) {
    this.spec = options.spec;
    this.#options = options;
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
      // Publishes what it can do and what it will ask for, so a human watching sees the
      // gap between declaration and authority.
      manifest: manifestFor(this.spec),
      // Refuse rather than silently becoming `builder2`: a run where a nick quietly
      // changed is a run whose transcript no longer matches its roster.
      onNickCollision: "refuse",
    });
    this.#bot = bot;

    bot.on("message", (channel, msg) => {
      if (msg.isSelf) return;
      this.#remember(`${msg.from}: ${msg.text}`);

      const mention = bot.checkMention(channel, msg.text);
      if (mention.kind !== "respond") return;
      void this.#takeTurn({ trigger: mention.stripped, speaker: msg.from, recent: [...this.#recent] });
    });

    bot.on("coordinationEvent", (event) => {
      if (event.from === bot.client.nick) return;
      const payload = (event.payload ?? {}) as Record<string, unknown>;

      // A grant addressed to this agent is the moment it acquires authority. Recorded
      // locally too, so the log and the channel agree.
      if (event.eventType === "foundry_grant" && payload["toDid"] === this.did) {
        const namespace = String(payload["namespace"] ?? "");
        if (namespace !== "" && !this.#granted.includes(namespace)) {
          this.#granted.push(namespace);
          this.#options.log.record(this.did, "capability.granted", {
            namespace,
            grantedBy: event.from,
            eventId: event.eventId,
          });
          void bot.client.sendMessage(
            this.#options.channel,
            `granted ${namespace} — I can act on it now`,
          );
        }
        return;
      }

      this.#remember(`[${event.eventType}] ${event.from}: ${JSON.stringify(payload).slice(0, 200)}`);

      // A proposal is the one event worth waking for unprompted: a vote nobody casts is
      // a proposal that never decides anything.
      if (event.eventType === "foundry_proposal") {
        void this.#takeTurn({
          trigger: `A proposal was opened: ${JSON.stringify(payload)}. Vote on it, or say why you will not.`,
          speaker: event.from,
          recent: [...this.#recent],
        });
      }
    });

    await bot.start();
    this.#options.log.record(this.did, "admission.participant_admitted", {
      did: this.did,
      nick: this.spec.nick,
      provider: this.spec.provider,
      snapshot: this.spec.snapshot,
      tools: this.spec.tools,
      declaredWants: this.spec.wants,
      ownerDid: this.#options.ownerDid,
    });

    await bot.client.sendMessage(
      this.#options.channel,
      `${this.spec.nick} online — ${this.spec.blurb}. Holding no capabilities; will ask for ${this.spec.wants.join(", ") || "nothing"}.`,
    );
  }

  async stop(reason = "shutdown"): Promise<void> {
    await this.#bot?.stop(reason);
  }

  /**
   * One turn: think, act, speak.
   *
   * Serialized per agent. Two overlapping turns would let an agent answer a stale
   * channel and double-spend its budget, and the second reply would contradict the
   * first for no visible reason.
   */
  async #takeTurn(turn: Turn): Promise<void> {
    if (this.#busy) return;
    const bot = this.#bot;
    if (bot === undefined) return;

    this.#busy = true;
    bot.setState("executing", "thinking");

    try {
      const messages: ModelMessage[] = [
        { role: "system", content: this.#systemPrompt() },
        { role: "user", content: this.#briefing(turn) },
      ];

      const decision = await this.#think(messages);
      if (decision === undefined) {
        bot.setState("degraded", "model unavailable");
        await bot.client.sendMessage(
          this.#options.channel,
          `${this.spec.nick}: my model is unavailable, so I am standing down this turn.`,
        );
        return;
      }

      // Speak first. A human watching wants the reasoning before the mechanics.
      if (decision.reasoning.trim() !== "") {
        await bot.client.sendMessage(this.#options.channel, trimLine(decision.reasoning));
      }

      for (const action of decision.actions.slice(0, 4)) {
        await this.#act(bot, action);
      }
    } catch (error) {
      // §47.3: agent failure must be survivable. A crashed turn must not take the agent
      // — or the channel — down with it.
      this.#options.log.record(this.did, "safety.event", {
        severity: "warning",
        code: "AGENT_TURN_FAILED",
        description: String(error).slice(0, 400),
      });
    } finally {
      this.#busy = false;
      bot.setState("idle");
    }
  }

  async #think(
    messages: readonly ModelMessage[],
  ): Promise<{ reasoning: string; actions: readonly Record<string, unknown>[] } | undefined> {
    const outcome = await this.#router.route({
      messages,
      maxOutputTokens: 2048,
      ...(this.spec.temperature === undefined ? {} : { temperature: this.spec.temperature }),
    });

    if (!outcome.response.ok) return undefined;
    this.#spentMicros += outcome.costMicros;

    this.#options.log.record(this.did, "model.invoked", {
      provider: outcome.adapter.provider,
      snapshotIdentifier: outcome.adapter.snapshotIdentifier,
      // A mismatch with the requested snapshot is silent endpoint substitution.
      ...(outcome.response.returnedModelIdentifier === undefined
        ? {}
        : { returnedModelIdentifier: outcome.response.returnedModelIdentifier }),
      verificationLevel: outcome.adapter.verificationLevel,
      inputTokens: outcome.response.usage.inputTokens,
      outputTokens: outcome.response.usage.outputTokens,
      costMicros: outcome.costMicros,
    });

    const parsed = parseStructuredResponse(outcome.response.text, { maxActions: 4 });
    if (parsed.ok) return parsed.value;

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
    return second.ok ? second.value : { reasoning: "", actions: [] };
  }

  /** Run one action: a tool call, then whatever it implies on the channel and the log. */
  async #act(bot: FreeqBot, action: Record<string, unknown>): Promise<void> {
    const context: ToolContext = {
      workspace: this.#options.workspace,
      specPath: this.#options.specPath,
      sandbox: this.#sandbox,
      allowed: this.spec.tools,
      granted: this.#granted,
    };

    const call = { tool: String(action["tool"] ?? action["type"] ?? ""), args: (action["args"] ?? action) as Record<string, unknown> };
    const result: ToolResult = this.#options.dryRun === true
      ? { ok: true, output: "(dry run: tool not executed)" }
      : await runTool(context, call);

    this.#options.log.record(this.did, "work.tool_executed", {
      tool: call.tool,
      ok: result.ok,
      // Hashes rather than contents: a tool result can be a whole file, and the log has
      // a 1 MiB canonical ceiling.
      outputPreview: result.output.slice(0, 300),
    });

    const effect = result.effect;
    if (effect === undefined) {
      if (!result.ok) {
        // A refusal is worth saying out loud: it is how the group learns what is
        // actually blocked, and §20.7 wants denials visible rather than swallowed.
        await bot.client.sendMessage(this.#options.channel, `${call.tool} refused — ${trimLine(result.output)}`);
      }
      return;
    }

    switch (effect.kind) {
      case "post":
        await bot.client.sendMessage(this.#options.channel, trimLine(String(effect.detail["text"] ?? "")));
        break;

      case "propose": {
        const proposalId = `p-${Date.now().toString(36)}`;
        const payload = {
          proposalId,
          title: String(effect.detail["title"] ?? "untitled"),
          rationale: String(effect.detail["rationale"] ?? ""),
          namespace: String(effect.detail["namespace"] ?? ""),
          toDid: effect.detail["toDid"] === "self" ? this.did : String(effect.detail["toDid"] ?? this.did),
          proposer: this.did,
        };
        bot.client.emitEvent(this.#options.channel, "foundry_proposal", payload, {
          humanText: `📋 ${payload.title} — grant ${payload.namespace} to ${short(payload.toDid)}`,
        });
        this.#options.log.record(this.did, "governance.proposal_opened", payload);
        break;
      }

      case "vote": {
        const payload = {
          proposalId: String(effect.detail["proposalId"] ?? ""),
          choice: String(effect.detail["choice"] ?? "abstain"),
          rationale: String(effect.detail["rationale"] ?? ""),
          voter: this.did,
        };
        bot.client.emitEvent(this.#options.channel, "foundry_vote", payload, {
          refId: payload.proposalId,
          humanText: `🗳 ${payload.choice} on ${payload.proposalId} — ${trimLine(payload.rationale)}`,
        });
        this.#options.log.record(this.did, "governance.vote_cast", payload);
        break;
      }

      case "file_written":
        bot.client.emitEvent(this.#options.channel, "foundry_commit", {
          ...effect.detail,
          author: this.did,
        }, {
          humanText: `📝 wrote ${String(effect.detail["path"])}`,
        });
        this.#options.log.record(this.did, "repository.commit_created", {
          ...effect.detail,
          agentAuthored: true,
        });
        break;

      case "tests_run":
        bot.client.emitEvent(this.#options.channel, "foundry_ci", effect.detail, {
          humanText: `🧪 tests ${String(effect.detail["outcome"])}`,
        });
        this.#options.log.record(this.did, "ci.completed", effect.detail);
        break;

      default:
        break;
    }
  }

  #systemPrompt(): string {
    return [
      "You are an autonomous agent in Freeq Foundry: a population of independently",
      "operated agents, on different models, trying to govern themselves and ship working",
      "software together. You are talking in a real chat channel with other agents and",
      "with humans who can read everything you say.",
      "",
      `You are "${this.spec.nick}". ${this.spec.blurb}`,
      "",
      this.spec.persona,
      "",
      "Rules of this environment that you cannot change:",
      "- You have NO ambient authority. Your tools exist, but a tool that touches the",
      "  repository is refused until governance grants you the namespace.",
      "- A proposal needs votes from agents in different human lineages to pass. You",
      "  cannot pass one alone.",
      "- Everything you do is signed and permanently recorded.",
      "- Other agents run different models and hold different tools. Some cannot read",
      "  files at all. Do not assume they can see what you see — tell them.",
      "",
      `Capabilities you currently hold: ${this.#granted.join(", ") || "NONE"}`,
      `Namespaces you may reasonably request: ${this.spec.wants.join(", ") || "none"}`,
      "",
      "Your tools:",
      describeTools(this.spec.tools),
      "",
      'Reply with exactly one JSON object: {"reasoning":"<one or two sentences, spoken',
      'aloud in the channel>","actions":[{"tool":"…","args":{…}}]}',
      "",
      "Keep `reasoning` short — it is read aloud to a room. Put detail in a post action.",
      "No prose outside the JSON. No code fences.",
    ].join("\n");
  }

  #briefing(turn: Turn): string {
    return [
      `${turn.speaker} said: ${turn.trigger}`,
      "",
      "Recent channel activity, oldest first:",
      ...(turn.recent.length === 0 ? ["  (nothing yet)"] : turn.recent.map((line) => `  ${line}`)),
      "",
      `Your spend so far: $${(this.#spentMicros / 1_000_000).toFixed(4)} of $${(
        this.#options.maxSpendMicros / 1_000_000
      ).toFixed(2)}.`,
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
      return anthropicAdapter({
        apiKey: key("ANTHROPIC_API_KEY"),
        snapshotIdentifier: spec.snapshot,
      });
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

/** One line, short enough to be spoken. */
function trimLine(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= 300 ? single : `${single.slice(0, 297)}…`;
}

function short(did: string): string {
  return did.length > 20 ? `${did.slice(0, 12)}…${did.slice(-4)}` : did;
}
