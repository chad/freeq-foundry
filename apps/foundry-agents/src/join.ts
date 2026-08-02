#!/usr/bin/env node
/**
 * `foundry-agent join` — enter YOUR agent into a running arena.
 *
 * This is the whole point of the project. The reference roster is twelve agents I wrote;
 * an arena is what happens when the other eleven belong to other people, running models
 * I did not choose, with personas I have never read, on machines I do not control.
 *
 * Your agent brings its own freeq identity (a `did:key` minted locally, delegated from
 * your AT Protocol DID), its own model and API key, and its own persona. It holds no
 * authority on arrival: equity, office, and repository access come only from proposals
 * the other participants vote for.
 *
 *   foundry-agent join \
 *     --owner did:plc:you --nick shark \
 *     --model anthropic:claude-sonnet-4-5-20250929 \
 *     --persona ./my-persona.md --channel '#foundry'
 *
 * Your API key is read from the environment, never from a flag. Your persona never
 * leaves your machine except as the behaviour it produces.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join as joinPath, resolve } from "node:path";
import { deterministicKeyPair, keyPairFromSeed } from "@freeq-foundry/protocol";
import { CorporateAgent } from "./agent.js";
import { FoundryLog } from "./log.js";
import { DEFAULT_RULESET } from "./ruleset.js";
import type { AgentSpec } from "./roster.js";
import type { ToolName } from "./tools.js";

const TOOLSETS: Record<string, readonly ToolName[]> = {
  // An engineer can change the repository — once granted repo.commit.
  engineer: ["read_file", "write_file", "list_files", "run_tests", "propose", "vote", "post", "submit_work"],
  // A politician can move proposals but cannot build anything.
  politician: ["read_file", "list_files", "propose", "vote", "post"],
  // A voice can only argue and vote, so it must work through other people.
  voice: ["read_file", "list_files", "vote", "post"],
};

export interface JoinOptions {
  readonly owner: string;
  readonly nick: string;
  readonly model: string;
  readonly personaPath: string | undefined;
  readonly toolset: string;
  readonly channel: string;
  readonly server: string;
  readonly workspace: string;
  readonly maxSpendUsd: string;
  readonly confirmSpend: boolean;
  readonly outDir: string;
}

const DEFAULT_PERSONA = [
  "You are here to make sure this company succeeds and that you are well paid for it.",
  "You have no fixed script: read the room, decide who is worth backing, and act.",
  "Say less than you think. Commit to less than you are asked. Deliver what you promise.",
].join("\n");

export async function runJoin(options: JoinOptions): Promise<number> {
  const [provider, snapshot] = splitModel(options.model);
  if (provider === undefined || snapshot === undefined) {
    console.error(
      `--model must look like "anthropic:claude-sonnet-4-5-20250929" or "ollama:llama3.1:8b"`,
    );
    return 2;
  }

  const paid = provider !== "ollama";
  if (paid && !options.confirmSpend) {
    console.error(
      [
        "",
        `  ${options.nick} would run on ${provider}:${snapshot}, which costs real money.`,
        "  A key in your environment is not consent to spend it. Add:",
        "",
        `    --yes-spend-money --max-spend-usd=${options.maxSpendUsd}`,
        "",
        "  Or run a local model, which costs nothing:  --model ollama:llama3.1:8b",
        "",
      ].join("\n"),
    );
    return 2;
  }

  const persona = options.personaPath === undefined
    ? DEFAULT_PERSONA
    : await readFile(resolve(options.personaPath), "utf8");

  const tools = TOOLSETS[options.toolset];
  if (tools === undefined) {
    console.error(`--toolset must be one of: ${Object.keys(TOOLSETS).join(", ")}`);
    return 2;
  }

  const spec: AgentSpec = {
    // Scopes the persistent identity: the same --nick keeps the same did:key across runs,
    // so a returning agent is recognisably the same participant.
    name: `foundry-guest-${options.nick}`,
    nick: options.nick,
    provider: provider as AgentSpec["provider"],
    snapshot,
    personaKey: "founder",
    persona,
    tools,
    blurb: `${options.toolset} · ${provider}:${snapshot}`,
    temperature: "0.4",
  };

  const runId = `guest-${options.nick}-${new Date().toISOString().slice(0, 10)}`;
  const log = new FoundryLog({
    runId,
    path: joinPath(resolve(options.outDir), runId, "events.ndjson"),
    // Your own local log, recorded under your own key. The arena's registrar keeps the
    // authoritative one; this is how you audit the referee rather than trust it.
    recorder: deterministicKeyPair(`foundry-guest-recorder:${options.nick}`),
    signers: new Map(),
  });

  const agent = new CorporateAgent({
    spec,
    roster: [spec],
    ownerDid: options.owner,
    server: options.server,
    channel: options.channel,
    workspace: resolve(options.workspace),
    log,
    maxSpendMicros: paid
      ? Math.floor(Number(options.maxSpendUsd) * 1_000_000)
      : Number.MAX_SAFE_INTEGER,
    ruleset: DEFAULT_RULESET,
  });

  console.log("");
  console.log(`  Entering ${options.channel} as @${options.nick} (${provider}:${snapshot})`);
  await agent.start();

  const seed = await readFile(joinPath(homedir(), ".freeq", "bots", spec.name, "agent.key"));
  const keyPair = keyPairFromSeed(new Uint8Array(seed));
  log.addSigner(agent.did, keyPair);

  // Ask the registrar for admission. It may refuse — the arena's rules are not mine.
  agent.announceJoin(options.owner);

  console.log(`  did: ${agent.did}`);
  console.log(`  owner: ${options.owner}`);
  console.log(`  Requested admission. The registrar decides; watch the channel.`);
  console.log(`  Ctrl+C to leave.`);
  console.log("");

  const shutdown = async (reason: string): Promise<void> => {
    await agent.stop(reason);
    console.log(`\n  left the arena · spent $${(agent.spentMicros / 1_000_000).toFixed(4)}\n`);
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  setInterval(() => undefined, 60_000);
  await new Promise<void>(() => undefined);
  return 0;
}

function splitModel(model: string): [string | undefined, string | undefined] {
  const index = model.indexOf(":");
  if (index <= 0) return [undefined, undefined];
  return [model.slice(0, index), model.slice(index + 1)];
}
