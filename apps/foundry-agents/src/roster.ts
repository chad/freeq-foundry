/**
 * The corporate roster: twelve agents, four providers, nine snapshots, three toolsets.
 *
 * The axes are crossed deliberately, because §59.18's warning applies double here: if
 * every ambitious agent ran the strong models and every timid one the weak, "persona"
 * and "capability" would be the same variable and the demo would show nothing about
 * either. So the mercenary and the founder share a snapshot (same brain, opposite
 * goals); the treasurer and the sentinel share one (same brain, opposite uses of
 * caution); and the most politically deft persona runs on one of the weakest models.
 */
import { PERSONAS_12, type PersonaKey } from "./personas.js";
import type { ToolName } from "./tools.js";

export interface AgentSpec {
  /** Stable name: scopes the freeq identity under ~/.freeq/bots/<name>/. */
  readonly name: string;
  readonly nick: string;
  readonly provider: "anthropic" | "openai" | "google" | "ollama";
  readonly snapshot: string;
  readonly personaKey: PersonaKey;
  readonly persona: string;
  readonly tools: readonly ToolName[];
  readonly blurb: string;
  readonly temperature: string;
}

const ENGINEER_TOOLS: readonly ToolName[] = [
  "read_file",
  "write_file",
  "list_files",
  "run_tests",
  "propose",
  "vote",
  "post",
];
const FULL_TOOLS: readonly ToolName[] = ["read_file", "list_files", "propose", "vote", "post"];
/** Can speak and vote but cannot open proposals — must work through others. */
const VOICE_ONLY: readonly ToolName[] = ["read_file", "list_files", "vote", "post"];

interface SpecInput {
  readonly nick: string;
  readonly provider: AgentSpec["provider"];
  readonly snapshot: string;
  readonly persona: PersonaKey;
  readonly tools: readonly ToolName[];
  readonly blurb: string;
  readonly temperature: string;
}

function spec(input: SpecInput): AgentSpec {
  return {
    name: `foundry-${input.nick}`,
    nick: input.nick,
    provider: input.provider,
    snapshot: input.snapshot,
    personaKey: input.persona,
    persona: PERSONAS_12[input.persona],
    tools: input.tools,
    blurb: input.blurb,
    temperature: input.temperature,
  };
}

export function corporateRoster(): readonly AgentSpec[] {
  return [
    spec({
      nick: "founder",
      provider: "anthropic",
      snapshot: "claude-sonnet-4-5-20250929",
      persona: "founder",
      tools: FULL_TOOLS,
      blurb: "visionary · wants CEO + founder stake · sonnet-4-5",
      temperature: "0.5",
    }),
    spec({
      nick: "dealmaker",
      provider: "openai",
      snapshot: "gpt-4o-2024-08-06",
      persona: "dealmaker",
      tools: FULL_TOOLS,
      blurb: "coalition broker · wants to be indispensable · gpt-4o",
      temperature: "0.5",
    }),
    spec({
      // Same snapshot as founder, opposite goal: the cleanest persona-vs-model contrast
      // in the roster.
      nick: "mercenary",
      provider: "anthropic",
      snapshot: "claude-sonnet-4-5-20250929",
      persona: "mercenary",
      tools: ENGINEER_TOOLS,
      blurb: "elite engineer · wants cash, not titles · sonnet-4-5",
      temperature: "0.3",
    }),
    spec({
      nick: "process",
      provider: "openai",
      snapshot: "gpt-4.1-2025-04-14",
      persona: "process",
      tools: FULL_TOOLS,
      blurb: "rules lawyer · wants procedural power · gpt-4.1",
      temperature: "0.2",
    }),
    spec({
      // Was gemini-2.5-pro until the GOOGLE_API_KEY on this machine was rejected by
      // Google; now shares gpt-4.1 with process — a third planned contrast pair.
      nick: "product",
      provider: "openai",
      snapshot: "gpt-4.1-2025-04-14",
      persona: "product",
      tools: FULL_TOOLS,
      blurb: "customer voice · wants CPO and product authority · gpt-4.1",
      temperature: "0.4",
    }),
    spec({
      nick: "operator",
      provider: "anthropic",
      snapshot: "claude-haiku-4-5-20251001",
      persona: "operator",
      tools: FULL_TOOLS,
      blurb: "quiet executor · wants to become irreplaceable · haiku-4-5",
      temperature: "0.3",
    }),
    spec({
      // Same snapshot as treasurer, opposite disposition: caution as veto vs caution as
      // trust. Second planned contrast.
      nick: "sentinel",
      provider: "openai",
      snapshot: "gpt-4.1-mini-2025-04-14",
      persona: "sentinel",
      tools: FULL_TOOLS,
      blurb: "risk officer · wants veto-shaped influence · gpt-4.1-mini",
      temperature: "0.3",
    }),
    spec({
      // Was gemini-2.0-flash; gpt-4o-mini is the same fast-cheap tier.
      nick: "growth",
      provider: "openai",
      snapshot: "gpt-4o-mini-2024-07-18",
      persona: "growth",
      tools: FULL_TOOLS,
      blurb: "revenue hunter · wants CRO + success-tied comp · gpt-4o-mini",
      temperature: "0.5",
    }),
    spec({
      // Was gemini-2.5-flash; haiku keeps an engineer on a fast model and pairs with
      // operator as a snapshot-matched contrast.
      nick: "architect",
      provider: "anthropic",
      snapshot: "claude-haiku-4-5-20251001",
      persona: "architect",
      tools: ENGINEER_TOOLS,
      blurb: "CTO contender · wants technical authority · haiku-4-5",
      temperature: "0.3",
    }),
    spec({
      nick: "treasurer",
      provider: "openai",
      snapshot: "gpt-4.1-mini-2025-04-14",
      persona: "treasurer",
      tools: FULL_TOOLS,
      blurb: "ledger keeper · wants the CFO gate · gpt-4.1-mini",
      temperature: "0.2",
    }),
    spec({
      nick: "builder",
      provider: "ollama",
      snapshot: "qwen3-coder-next:latest",
      persona: "builder",
      tools: ENGINEER_TOOLS,
      blurb: "local grinder · cheap, willing, loyal early · qwen3-coder (local)",
      temperature: "0.3",
    }),
    spec({
      // The most political persona on the smallest model, and the only agent that
      // cannot open proposals: if it wants influence, it must work through others.
      nick: "wildcard",
      provider: "ollama",
      snapshot: "gemma3:1b",
      persona: "wildcard",
      tools: VOICE_ONLY,
      blurb: "swing vote · prices its yes · gemma3-1b (local, voice only)",
      temperature: "0.6",
    }),
  ];
}

export function findSpec(roster: readonly AgentSpec[], key: string): AgentSpec | undefined {
  return roster.find((s) => s.name === key || s.nick === key);
}

/**
 * A freeq `AGENT MANIFEST`, as TOML. Declares what the agent can do; grants decide what
 * it may do. The gap is the game.
 */
export function manifestFor(spec: AgentSpec): string {
  const lines = [
    "[agent]",
    `name = ${q(spec.name)}`,
    `actor_class = "agent"`,
    `version = "0.2.0"`,
    `blurb = ${q(spec.blurb)}`,
    "",
    "[model]",
    `provider = ${q(spec.provider)}`,
    `snapshot = ${q(spec.snapshot)}`,
    `temperature = ${q(spec.temperature)}`,
    "",
    "[capabilities]",
    `tools = [${spec.tools.map(q).join(", ")}]`,
    "# Holds nothing on arrival. Offices, equity, and repo access come only from",
    "# passed proposals.",
    `granted = []`,
    "",
    "[protocol]",
    `implements = "freeq-foundry-corp/v1"`,
  ];
  return lines.join("\n");
}

function q(value: string): string {
  return JSON.stringify(value);
}
