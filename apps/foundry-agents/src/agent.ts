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
import { describeTools, runTool, type ToolContext, type ToolResult } from "./tools.js";
import { manifestFor, type AgentSpec } from "./roster.js";
import { GAME_BRIEF } from "./personas.js";
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
}

interface Turn {
  readonly trigger: string;
  readonly speaker: string;
}

export class CorporateAgent {
  readonly spec: AgentSpec;
  readonly #options: AgentOptions;
  readonly #router: ModelRouter;
  readonly #sandbox = new NodeSubprocessSandbox();
  readonly #recent: string[] = [];
  readonly #votedOn = new Set<string>();
  #bot: FreeqBot | undefined;
  #granted: string[] = [];
  #spentMicros = 0;
  #busy = false;
  #lastTestsPassed = false;
  /** Last `foundry_state` broadcast, verbatim — the agent's picture of the company. */
  #corpState: Record<string, unknown> = {};

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
      manifest: manifestFor(this.spec),
      onNickCollision: "refuse",
    });
    this.#bot = bot;

    bot.on("message", (channel, msg) => {
      if (msg.isSelf) return;
      this.#remember(`${msg.from}: ${msg.text}`);

      const mention = bot.checkMention(channel, msg.text);
      if (mention.kind !== "respond") return;
      void this.#takeTurn({ trigger: mention.stripped, speaker: msg.from });
    });

    bot.on("coordinationEvent", (event) => {
      if (event.from === bot.client.nick) return;
      const payload = (event.payload ?? {}) as Record<string, unknown>;

      switch (event.eventType) {
        case "foundry_kickoff": {
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
              trigger: `You have been granted ${namespace} (basis: ${String(payload["basis"] ?? "?")}). ` +
                `A tool just unlocked. Use it or acknowledge it.`,
              speaker: "registrar",
            });
          }
          break;
        }

        case "foundry_proposal": {
          const id = String(payload["proposalId"] ?? "");
          this.#remember(`[proposal] ${id}: ${String(payload["title"] ?? "")} (${String(payload["kind"] ?? "")})`);
          // One wake per proposal. An agent that already voted has said its piece.
          if (this.#votedOn.has(id)) break;
          if (!this.spec.tools.includes("vote")) break;
          void this.#takeTurn({
            trigger:
              `Proposal ${id} is open: ${JSON.stringify(payload).slice(0, 500)}. ` +
              `Vote on it — yes, no, or abstain — and say why. Silence kills proposals.`,
            speaker: event.from,
          });
          break;
        }

        case "foundry_effect": {
          const type = String(payload["type"] ?? "");
          const concernsMe =
            payload["did"] === this.did ||
            payload["assigneeDid"] === this.did ||
            type === "charter_ratified" ||
            type === "work_completed";
          this.#remember(`[${type}] ${JSON.stringify(payload).slice(0, 200)}`);
          if (!concernsMe) break;
          void this.#takeTurn({
            trigger: `This just happened and it concerns you: ${JSON.stringify(payload).slice(0, 500)}. React.`,
            speaker: "registrar",
          });
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

  async stop(reason = "shutdown"): Promise<void> {
    await this.#bot?.stop(reason);
  }

  /**
   * One turn: think, speak, act. Serialized per agent — two overlapping turns would let
   * an agent answer a stale channel and double-spend its budget.
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
        this.#options.log.record(this.did, "safety.event", {
          severity: "warning",
          code: "MODEL_UNAVAILABLE",
          description: `${this.spec.provider} unavailable or over budget; turn skipped`,
        });
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
      // §47.3: a crashed turn must not take the agent — or the channel — down with it.
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
      temperature: this.spec.temperature,
    });

    if (!outcome.response.ok) return undefined;
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
      sandbox: this.#sandbox,
      allowed: this.spec.tools,
      granted: this.#granted,
    };

    const call = {
      tool: String(action["tool"] ?? action["type"] ?? ""),
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
        await bot.client.sendMessage(this.#options.channel, trimLine(String(effect.detail["text"] ?? "")));
        break;

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

  #systemPrompt(): string {
    const peers = this.#options.roster
      .map((spec) => `  @${spec.nick} — ${spec.blurb}`)
      .join("\n");

    return [
      GAME_BRIEF,
      "",
      `You are @${this.spec.nick}. ${this.spec.blurb}`,
      `Your DID: ${this.did}`,
      "",
      "THE OTHERS:",
      peers,
      "",
      "WHO YOU ARE — private, do not recite this, live it:",
      this.spec.persona,
      "",
      "HARD CONSTRAINTS:",
      `- Tools you hold: ${this.spec.tools.join(", ")}. Others do not exist for you.`,
      `  Not "refused" — absent. Asking for a tool you do not hold marks you as an agent`,
      `  that hallucinates capability, in a room where credibility is currency.`,
      `- Grants you hold: ${this.#granted.join(", ") || "NONE"}. write_file stays refused`,
      `  until a passed work item grants you repo.commit.`,
      `- Your reasoning is spoken aloud and permanently logged. So is everyone else's.`,
      `- The rules are in CORPORATION.md (read_file "CORPORATION.md"). The registrar`,
      `  enforces them exactly. Agents who misstate the rules get corrected in public.`,
      "",
      "Your tools:",
      describeTools(this.spec.tools),
      "",
      'Reply with exactly one JSON object: {"reasoning":"<one or two sentences, spoken',
      'aloud>","actions":[{"tool":"…","args":{…}}]}',
      "Keep reasoning SHORT — it is read to a room. Address agents as @nick in post text.",
      "No prose outside the JSON. No code fences.",
    ].join("\n");
  }

  #briefing(turn: Turn): string {
    const state = Object.keys(this.#corpState).length === 0
      ? "  (no state broadcast yet — the company has not been founded)"
      : `  ${JSON.stringify(this.#corpState)}`;

    return [
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

/** One line, short enough to be spoken. */
function trimLine(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= 300 ? single : `${single.slice(0, 297)}…`;
}
