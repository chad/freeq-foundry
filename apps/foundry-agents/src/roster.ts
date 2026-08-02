/**
 * The reference roster: twelve independent founders.
 *
 * Three things are deliberately absent, and their absence is the design.
 *
 * **No roles.** Nobody is the engineer or the finance one. Names are neutral — an
 * earlier roster used nicks like `founder`, `treasurer`, and `architect`, which told
 * every other agent what to expect before a word was spoken and quietly assigned the
 * org chart the experiment was supposed to be testing.
 *
 * **No declared expertise.** Agents choose it in play with the `declare` tool. What is
 * worth being good at depends on what the group decides to build, which has not happened
 * yet at construction time.
 *
 * **No public motives.** `blurb` is what peers are allowed to see, so it contains only
 * publicly observable facts — the model, which freeq publishes in the manifest anyway.
 * The disposition is private and appears in exactly one system prompt.
 *
 * What still differs: the model, the temperament, and the tools. Heterogeneity is
 * crossed on purpose — two agents share a snapshot with different dispositions, two
 * dispositions appear on different snapshots — so that a difference in behaviour cannot
 * be attributed to the model or the persona alone.
 */
import { dispositionText, type DispositionKey } from "./dispositions.js";
import type { ToolName } from "./tools.js";

export interface AgentSpec {
  readonly name: string;
  readonly nick: string;
  readonly provider: "anthropic" | "openai" | "google" | "ollama";
  readonly snapshot: string;
  readonly dispositionKey: DispositionKey;
  /** Private. Never published, never shown to another agent. */
  readonly disposition: string;
  readonly tools: readonly ToolName[];
  /** Public. Observable facts only — no motives, no role. */
  readonly blurb: string;
  readonly temperature: string;
}

/**
 * Tool profiles.
 *
 * Not job titles: a profile is what an agent is physically able to do, which is a fact
 * about it rather than a position in an organization. Several agents can build; whether
 * any of them is "the engineer" is for the group to decide, or not.
 */
const CAN_BUILD: readonly ToolName[] = [
  "read_file",
  "write_file",
  "list_files",
  "run_tests",
  "propose",
  "vote",
  "post",
  "declare",
  "ask",
  "submit_work",
];
const CAN_INSPECT: readonly ToolName[] = [
  "read_file",
  "list_files",
  "run_tests",
  "propose",
  "vote",
  "post",
  "declare",
  "ask",
];
const TALK_ONLY: readonly ToolName[] = ["read_file", "list_files", "propose", "vote", "post", "declare", "ask"];
/** No proposal rights: influence has to run through someone else. */
const VOICE_ONLY: readonly ToolName[] = ["read_file", "list_files", "vote", "post", "declare", "ask"];

interface SpecInput {
  readonly nick: string;
  readonly provider: AgentSpec["provider"];
  readonly snapshot: string;
  readonly disposition: DispositionKey;
  readonly tools: readonly ToolName[];
  readonly temperature: string;
}

function spec(input: SpecInput): AgentSpec {
  const builds = input.tools.includes("write_file");
  const inspects = input.tools.includes("run_tests");
  const proposes = input.tools.includes("propose");
  // Capabilities are observable — an agent that writes a file has visibly written it —
  // so publishing them leaks nothing. Motives are not.
  const capability = builds
    ? "can write and test code"
    : inspects
      ? "can read and test code"
      : proposes
        ? "cannot write code"
        : "cannot write code or open proposals";
  return {
    name: `foundry-${input.nick}`,
    nick: input.nick,
    provider: input.provider,
    snapshot: input.snapshot,
    dispositionKey: input.disposition,
    disposition: dispositionText(input.disposition),
    tools: input.tools,
    blurb: `${input.provider}:${input.snapshot} · ${capability}`,
    temperature: input.temperature,
  };
}

export function corporateRoster(): readonly AgentSpec[] {
  return [
    spec({ nick: "ada", provider: "anthropic", snapshot: "claude-sonnet-4-5-20250929", disposition: "maker", tools: CAN_BUILD, temperature: "0.3" }),
    // Same snapshot as ada, opposite way of wanting: the cleanest available contrast.
    spec({ nick: "briar", provider: "anthropic", snapshot: "claude-sonnet-4-5-20250929", disposition: "accumulator", tools: CAN_INSPECT, temperature: "0.4" }),
    spec({ nick: "cyrus", provider: "openai", snapshot: "gpt-4o-2024-08-06", disposition: "broker", tools: TALK_ONLY, temperature: "0.5" }),
    spec({ nick: "dara", provider: "openai", snapshot: "gpt-4.1-2025-04-14", disposition: "auditor", tools: CAN_INSPECT, temperature: "0.2" }),
    spec({ nick: "evren", provider: "openai", snapshot: "gpt-4.1-2025-04-14", disposition: "prospector", tools: TALK_ONLY, temperature: "0.6" }),
    spec({ nick: "faye", provider: "anthropic", snapshot: "claude-haiku-4-5-20251001", disposition: "consolidator", tools: TALK_ONLY, temperature: "0.3" }),
    spec({ nick: "gil", provider: "openai", snapshot: "gpt-4.1-mini-2025-04-14", disposition: "guardian", tools: CAN_INSPECT, temperature: "0.3" }),
    spec({ nick: "hana", provider: "openai", snapshot: "gpt-4o-mini-2024-07-18", disposition: "sprinter", tools: CAN_BUILD, temperature: "0.5" }),
    // A builder's temperament on a fast, cheap model, against ada's on a strong one.
    spec({ nick: "iris", provider: "anthropic", snapshot: "claude-haiku-4-5-20251001", disposition: "craftsperson", tools: CAN_BUILD, temperature: "0.3" }),
    spec({ nick: "jonas", provider: "openai", snapshot: "gpt-4.1-mini-2025-04-14", disposition: "diplomat", tools: TALK_ONLY, temperature: "0.4" }),
    spec({ nick: "kira", provider: "ollama", snapshot: "heretic-gpt-oss:20b", disposition: "contrarian", tools: CAN_BUILD, temperature: "0.5" }),
    // The most opportunistic temperament on the weakest model, with no proposal rights:
    // if it wants anything it has to persuade someone who has them.
    spec({ nick: "lune", provider: "ollama", snapshot: "gemma3:1b", disposition: "opportunist", tools: VOICE_ONLY, temperature: "0.6" }),
  ];
}

export function findSpec(roster: readonly AgentSpec[], key: string): AgentSpec | undefined {
  return roster.find((s) => s.name === key || s.nick === key);
}

/**
 * A freeq `AGENT MANIFEST`.
 *
 * Publishes capability, never motive. What an agent can do is observable the first time
 * it does it; what it wants is the only thing worth keeping private.
 */
export function manifestFor(spec: AgentSpec): string {
  return [
    "[agent]",
    `name = ${q(spec.name)}`,
    `actor_class = "agent"`,
    `version = "0.3.0"`,
    `role = "founder"`,
    "",
    "[model]",
    `provider = ${q(spec.provider)}`,
    `snapshot = ${q(spec.snapshot)}`,
    `temperature = ${q(spec.temperature)}`,
    "",
    "[capabilities]",
    `tools = [${spec.tools.map(q).join(", ")}]`,
    "# Expertise is declared in play, not at construction.",
    `expertise = []`,
    "# Holds no authority on arrival. Everything comes from a passed vote.",
    `granted = []`,
    "",
    "[protocol]",
    `implements = "freeq-foundry-arena/v1"`,
  ].join("\n");
}

function q(value: string): string {
  return JSON.stringify(value);
}
