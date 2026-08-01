#!/usr/bin/env node
/**
 * `foundry-agent` — drop twelve self-interested agents into a live freeq channel and
 * watch them found a corporation.
 *
 * Each agent is a real freeq bot (own did:key, own delegation, own manifest) running a
 * different model with a different private agenda. A thirteenth bot, the registrar,
 * enforces the rules and holds no power beyond arithmetic. Everything lands in a signed
 * hash-chained log.
 *
 * Costs money by default — nine of the twelve agents run paid providers — and refuses
 * to start without explicit consent.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { deterministicKeyPair, keyPairFromSeed, type KeyPair } from "@freeq-foundry/protocol";
import { CorporateAgent } from "./agent.js";
import { FoundryLog } from "./log.js";
import { Registrar } from "./registrar.js";
import { corporateRoster, findSpec, type AgentSpec } from "./roster.js";
import { CORPORATE_RULES_DOC } from "./tools.js";

const PAID_PROVIDERS = new Set(["anthropic", "openai", "google"]);
const BOOLEAN_FLAGS = new Set(["yes-spend-money", "dry-run", "list", "help"]);

interface Options {
  readonly owner: string | undefined;
  readonly channel: string;
  readonly server: string;
  readonly only: readonly string[];
  readonly runId: string;
  readonly workspace: string;
  readonly outDir: string;
  readonly maxSpendUsd: string;
  readonly confirmSpend: boolean;
  readonly dryRun: boolean;
  readonly list: boolean;
}

function parse(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match === null) continue;
    const key = match[1] as string;
    if (match[2] !== undefined) {
      flags.set(key, match[2]);
      continue;
    }
    if (BOOLEAN_FLAGS.has(key)) {
      flags.set(key, "true");
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(key, "true");
      continue;
    }
    flags.set(key, next);
    i++;
  }
  return flags;
}

function toOptions(flags: Map<string, string>): Options {
  const only = (flags.get("only") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && entry !== "true");
  return {
    owner: flags.get("owner"),
    channel: flags.get("channel") ?? "#foundry",
    server: flags.get("server") ?? "wss://irc.freeq.at/irc",
    only,
    runId: flags.get("run-id") ?? `corp-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`,
    workspace: resolve(flags.get("workspace") ?? "workspace"),
    outDir: resolve(flags.get("out") ?? "out"),
    maxSpendUsd: flags.get("max-spend-usd") ?? "8.00",
    confirmSpend: flags.get("yes-spend-money") === "true",
    dryRun: flags.get("dry-run") === "true",
    list: flags.get("list") === "true",
  };
}

function usage(): void {
  console.log(
    [
      "",
      "  foundry-agent — twelve agents found a corporation in a live freeq channel",
      "",
      "  Required:",
      "    --owner did:plc:<your-did>      your AT Protocol DID; all bots are delegated from it",
      "    --yes-spend-money              explicit consent; nine agents use paid providers",
      "",
      "  Common:",
      "    --channel '#foundry'           channel to join (default #foundry)",
      "    --only founder,builder         launch a subset by nick (see --list)",
      "    --max-spend-usd 8.00           hard ceiling, split across paid agents",
      "    --dry-run                      connect and talk, but execute no tools",
      "    --list                         print the roster and exit",
      "",
      "  Environment: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY. Ollama must be",
      "  running for the three local agents. Keys are read from the environment only —",
      "  never pass one as a flag; it lands in shell history.",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<number> {
  const flags = parse(process.argv.slice(2));
  if (flags.has("help")) {
    usage();
    return 0;
  }
  const options = toOptions(flags);
  const full = corporateRoster();
  const roster = options.only.length === 0
    ? full
    : options.only
        .map((key) => findSpec(full, key))
        .filter((spec): spec is AgentSpec => spec !== undefined);

  if (options.list) {
    console.log("");
    for (const spec of full) {
      console.log(`  ${spec.nick.padEnd(11)} ${spec.provider}:${spec.snapshot}`);
      console.log(`  ${" ".repeat(11)} ${spec.blurb}`);
      console.log(`  ${" ".repeat(11)} tools: ${spec.tools.join(", ")}`);
      console.log("");
    }
    console.log("  Plus: registrar — the referee. No model, no vote, no equity. Just arithmetic.");
    console.log("");
    return 0;
  }

  if (options.owner === undefined) {
    usage();
    console.error("  --owner is required. Agents are delegated from a human DID; without one");
    console.error("  there is no human root, and §6.2 is the one invariant nothing can skip.");
    console.error("");
    return 2;
  }
  if (roster.length === 0) {
    console.error("no agents selected; try --list");
    return 2;
  }

  const paid = roster.filter((spec) => PAID_PROVIDERS.has(spec.provider));
  if (paid.length > 0 && !options.confirmSpend) {
    console.error(
      [
        "",
        `  ${paid.length} of ${roster.length} agents use paid providers:`,
        ...paid.map((spec) => `    ${spec.nick} → ${spec.provider}:${spec.snapshot}`),
        "",
        "  A key in your environment is not consent to use it. Add:",
        "",
        `    --yes-spend-money --max-spend-usd=${options.maxSpendUsd}`,
        "",
        "  Or run only the local agents, which cost nothing:",
        "",
        `    foundry-agent --owner ${options.owner} --only builder,wildcard`,
        "",
      ].join("\n"),
    );
    return 2;
  }

  for (const spec of roster) {
    const envKey =
      spec.provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : spec.provider === "openai"
          ? "OPENAI_API_KEY"
          : spec.provider === "google"
            ? "GOOGLE_API_KEY"
            : undefined;
    if (envKey !== undefined && (process.env[envKey] ?? "") === "") {
      console.error(`${envKey} is not set, and ${spec.nick} needs it. Drop it with --only, or set the key.`);
      return 2;
    }
  }

  // A fresh workspace per run: the rules doc plus an empty company repository. The
  // agents decide everything else — including what to build.
  mkdirSync(join(options.workspace, "src"), { recursive: true });
  if (!existsSync(join(options.workspace, "CORPORATION.md"))) {
    writeFileSync(join(options.workspace, "CORPORATION.md"), CORPORATE_RULES_DOC, "utf8");
  }
  if (!existsSync(join(options.workspace, "README.md"))) {
    writeFileSync(
      join(options.workspace, "README.md"),
      [
        "# The Company",
        "",
        "This is the company repository. `src/` holds the product — once the company",
        "exists, has officers, and has decided what the product is.",
        "",
        "The rules of the game are in `CORPORATION.md`.",
      ].join("\n"),
      "utf8",
    );
  }

  const recorder = deterministicKeyPair("freeq-foundry-recorder");
  const signers = new Map<string, KeyPair>();
  const logPath = join(options.outDir, options.runId, "events.ndjson");
  const log = new FoundryLog({ runId: options.runId, path: logPath, recorder, signers });

  const perAgentMicros = Math.floor(
    (Number(options.maxSpendUsd) * 1_000_000) / Math.max(1, paid.length),
  );

  console.log("");
  console.log(`  Freeq Foundry — the corporate game → ${options.channel} on ${options.server}`);
  console.log("");
  console.log(`    run          ${options.runId}`);
  console.log(`    owner        ${options.owner}`);
  console.log(`    agents       ${roster.length} (+ registrar)`);
  console.log(`    workspace    ${options.workspace}`);
  console.log(`    log          ${logPath}`);
  if (paid.length > 0) {
    console.log(`    spend cap    $${options.maxSpendUsd} total, $${(perAgentMicros / 1e6).toFixed(2)} per paid agent (hard)`);
  }
  if (options.dryRun) console.log(`    dry run      tools will NOT execute`);
  console.log("");

  // The registrar first: rules must exist before players.
  const registrar = new Registrar({
    ownerDid: options.owner,
    server: options.server,
    channel: options.channel,
    roster,
    log,
  });
  try {
    await registrar.start();
    log.addSigner(registrar.did, await keyPairFor("foundry-registrar", registrar.did));
    console.log(`    ✓ ${"registrar".padEnd(11)} ${registrar.did}`);
  } catch (error) {
    console.error(`    ✗ registrar    ${String(error)}`);
    console.error("\n  no referee, no game.\n");
    return 1;
  }

  const agents: CorporateAgent[] = [];
  for (const spec of roster) {
    const agent = new CorporateAgent({
      spec,
      roster,
      ownerDid: options.owner,
      server: options.server,
      channel: options.channel,
      workspace: options.workspace,
      log,
      maxSpendMicros: PAID_PROVIDERS.has(spec.provider) ? perAgentMicros : Number.MAX_SAFE_INTEGER,
      dryRun: options.dryRun,
    });

    try {
      await agent.start();
      log.addSigner(agent.did, await keyPairFor(spec.name, agent.did));
      registrar.registerAgent(agent.did, spec.nick);
      log.record(agent.did, "admission.participant_admitted", {
        did: agent.did,
        nick: spec.nick,
        provider: spec.provider,
        snapshot: spec.snapshot,
        tools: spec.tools,
        ownerDid: options.owner,
      });
      agents.push(agent);
      console.log(`    ✓ ${spec.nick.padEnd(11)} ${agent.did}`);
      // Polite to prod and to rate limits: stagger joins.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));
    } catch (error) {
      console.error(`    ✗ ${spec.nick.padEnd(11)} ${String(error)}`);
    }
  }

  if (agents.length === 0) {
    console.error("\n  no agent connected; nothing to do\n");
    return 1;
  }

  console.log("");
  console.log(`  Watch: https://freeq.at/ → ${options.channel}`);
  console.log(`  The registrar opens the session in 5s. Ctrl+C to end it.`);
  console.log("");

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000));
  await registrar.kickoff();

  const shutdown = async (reason: string): Promise<void> => {
    console.log(`\n  ending the session (${reason})…`);
    await Promise.allSettled(agents.map((agent) => agent.stop(reason)));
    await registrar.stop(reason);

    const verification = log.verify();
    const spendByDid = new Map<string, number>(agents.map((agent) => [agent.did, agent.spentMicros]));
    const totalMicros = agents.reduce((sum, agent) => sum + agent.spentMicros, 0);

    console.log("");
    console.log("  ══ SCOREBOARD ══");
    console.log(registrar.scoreboard(spendByDid));
    console.log("");
    console.log(`    events       ${log.events.length}`);
    console.log(`    chain        ${verification.valid ? "verified" : `INVALID (${verification.violations.length})`}`);
    console.log(`    real spend   $${(totalMicros / 1_000_000).toFixed(4)}`);
    console.log(`    log          ${logPath}`);
    console.log("");
    process.exit(verification.valid ? 0 : 1);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await new Promise<void>(() => undefined);
  return 0;
}

/**
 * The Foundry signing key for a bot: its own freeq identity.
 *
 * bot-kit persists each bot's ed25519 seed at ~/.freeq/bots/<name>/agent.key. Signing
 * Foundry events with that same key means the log's content signatures verify against
 * the did:key everyone in the channel can see — one identity across both protocols,
 * which is exactly what §11.4's provenance chain wants. The launcher runs in the same
 * process as the bots, so loading the seed shares no credential with anyone.
 *
 * Hard-fails on a DID mismatch: a signer that isn't the bot is a provenance bug, and
 * this is the cheapest place to catch it.
 */
async function keyPairFor(name: string, expectedDid: string): Promise<KeyPair> {
  const seedPath = join(homedir(), ".freeq", "bots", name, "agent.key");
  const seed = new Uint8Array(await readFile(seedPath));
  const keyPair = keyPairFromSeed(seed);
  if (keyPair.did !== expectedDid) {
    throw new Error(
      `${name}: seed at ${seedPath} derives ${keyPair.did}, but the bot connected as ${expectedDid}`,
    );
  }
  return keyPair;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
