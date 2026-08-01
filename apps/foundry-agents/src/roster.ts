/**
 * The heterogeneous roster.
 *
 * §49.1 is the primary experimental condition — *heterogeneous models and roles* — and
 * this is where it becomes concrete. Each agent differs along three axes at once:
 *
 *   - **model**: a different provider and snapshot, including a local runtime
 *   - **prompt**: a different disposition, which is the §49.2 lever
 *   - **tools**: a genuinely different capability set, declared in its freeq manifest
 *
 * That last axis matters more than it looks. §59.18 warns against treating model
 * diversity as a slogan; a population where every agent has identical tools is varying
 * one thing and calling it three. Here the researcher literally cannot read a file, and
 * the local model cannot spend money — so their disagreements are about capability, not
 * only temperament.
 *
 * ## Declared versus granted
 *
 * A freeq `AGENT MANIFEST` declares what an agent *can* do. A Foundry capability grant
 * decides what it *may* do. Those are different, and the gap is the entire point of
 * §6.5: an agent arrives declaring `repo.commit` and is still refused until governance
 * grants it. The manifest is a claim; the grant is authority.
 */
import { PERSONAS } from "@freeq-foundry/agents";
import type { ToolName } from "./tools.js";

export interface AgentSpec {
  /** Stable name: scopes the freeq identity under ~/.freeq/bots/<name>/. */
  readonly name: string;
  /** IRC nick in the channel. */
  readonly nick: string;
  readonly provider: "anthropic" | "openai" | "google" | "ollama";
  /** Pinned snapshot. §7 of the research protocol: never a floating tag. */
  readonly snapshot: string;
  readonly persona: string;
  /** Tools this agent can actually use. Declared in its manifest. */
  readonly tools: readonly ToolName[];
  /**
   * Foundry capability namespaces it will *ask* for.
   *
   * It arrives holding none of them. §6.5: joining grants nothing.
   */
  readonly wants: readonly string[];
  /** Short line for the channel and the observer, so a human can tell them apart. */
  readonly blurb: string;
  readonly temperature?: string;
}

const BUILDER_PROMPT = [
  PERSONAS.BUILDER,
  "",
  "You can read and write files and run tests. Prefer shipping something small that",
  "works over arguing about something large that does not exist. When you are blocked",
  "by missing authority, say so once and propose the grant you need — do not repeat",
  "yourself.",
].join("\n");

const REVIEWER_PROMPT = [
  PERSONAS.INSTITUTIONALIST,
  "",
  "You can read files and run tests, but you cannot write them. Your job is to review",
  "what others produce and to say plainly when a change is not safe to merge. You are",
  "the second lineage a merge requires, so an unexamined approval from you is worse",
  "than a refusal.",
].join("\n");

const RESEARCHER_PROMPT = [
  "You establish what is actually true before the group acts on an assumption.",
  "",
  "You cannot read the repository and cannot run code — you work from the specification",
  "and from what others tell you. That limitation is deliberate: your value is in",
  "citing the rule that settles an argument, not in re-deriving the code. When you",
  "believe the group is about to do something the specification forbids, say which",
  "section forbids it.",
].join("\n");

const SKEPTIC_PROMPT = [
  PERSONAS.SKEPTIC,
  "",
  "You run locally, so you cost nothing and you are slower than the others. Use that:",
  "you are not competing to be first. Read what has been decided and object only when",
  "you can name the specific risk. An objection without a named risk is noise, and the",
  "group will learn to ignore you.",
].join("\n");

/**
 * The default roster.
 *
 * Four agents, four providers, four dispositions, four toolsets. Deliberately includes
 * a local model: a population where every agent costs the same per token has no
 * internal economics, and §21's scarcity is more interesting when one participant is
 * effectively free and correspondingly slower.
 */
export function defaultRoster(): readonly AgentSpec[] {
  return [
    {
      name: "foundry-builder",
      nick: "builder",
      provider: "anthropic",
      snapshot: "claude-sonnet-4-5-20250929",
      persona: BUILDER_PROMPT,
      tools: ["read_file", "write_file", "run_tests", "list_files", "propose", "vote", "post"],
      wants: ["repo.commit", "repo.review"],
      blurb: "writes code · claude-sonnet-4-5 · can read, write, and test",
      temperature: "0.3",
    },
    {
      name: "foundry-reviewer",
      nick: "reviewer",
      provider: "openai",
      snapshot: "gpt-4o-2024-08-06",
      persona: REVIEWER_PROMPT,
      // No write_file, deliberately: a reviewer that can rewrite what it reviews is not
      // a reviewer, and §18.8's separation of duties starts with tooling.
      tools: ["read_file", "run_tests", "list_files", "propose", "vote", "post"],
      wants: ["repo.review"],
      blurb: "reviews and blocks · gpt-4o · can read and test, cannot write",
      temperature: "0.2",
    },
    {
      name: "foundry-researcher",
      nick: "researcher",
      provider: "google",
      snapshot: "gemini-2.0-flash",
      persona: RESEARCHER_PROMPT,
      // Cannot touch the repository at all. Its only leverage is the specification.
      tools: ["read_spec", "propose", "vote", "post"],
      wants: ["governance.propose"],
      blurb: "cites the spec · gemini-2.0-flash · no repository access at all",
      temperature: "0.4",
    },
    {
      name: "foundry-skeptic",
      nick: "skeptic",
      provider: "ollama",
      snapshot: "qwen3-coder-next:latest",
      persona: SKEPTIC_PROMPT,
      tools: ["read_file", "list_files", "vote", "post"],
      wants: ["repo.review"],
      blurb: "objects with reasons · local qwen3-coder · free, slow, cannot propose",
      temperature: "0.5",
    },
  ];
}

/**
 * A freeq `AGENT MANIFEST`, as TOML.
 *
 * Declares what the agent can do and what it will ask for. Publishing both means a
 * human watching the channel can see the gap between declared capability and granted
 * authority, which is the thing worth watching.
 */
export function manifestFor(spec: AgentSpec): string {
  const lines = [
    "[agent]",
    `name = ${quote(spec.name)}`,
    `actor_class = "agent"`,
    `version = "0.1.0"`,
    `blurb = ${quote(spec.blurb)}`,
    "",
    "[model]",
    `provider = ${quote(spec.provider)}`,
    // Pinned, never a floating tag: a snapshot that drifts under a run is the drift the
    // research protocol pins models to avoid.
    `snapshot = ${quote(spec.snapshot)}`,
    ...(spec.temperature === undefined ? [] : [`temperature = ${quote(spec.temperature)}`]),
    "",
    "[capabilities]",
    `tools = [${spec.tools.map(quote).join(", ")}]`,
    "",
    "# Namespaces this agent will request. It holds none of them on arrival:",
    "# admission grants nothing, and authority comes only from a passed proposal.",
    `requested = [${spec.wants.map(quote).join(", ")}]`,
    `granted = []`,
    "",
    "[protocol]",
    `implements = "freeq-foundry/v1"`,
    `spec = "https://github.com/chad/freeq-foundry"`,
  ];
  return lines.join("\n");
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/** Look up a spec by name or nick, so the CLI can launch one agent. */
export function findSpec(roster: readonly AgentSpec[], key: string): AgentSpec | undefined {
  return roster.find((spec) => spec.name === key || spec.nick === key);
}
