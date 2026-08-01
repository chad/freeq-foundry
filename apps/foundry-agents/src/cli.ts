#!/usr/bin/env node
/**
 * `foundry-agent` — launch heterogeneous Foundry agents into a live freeq channel.
 *
 * Each agent is a real freeq bot with its own `did:key`, its own owner delegation, its
 * own model, its own prompt, and its own tools. They coordinate by talking, and every
 * action lands in a signed local log as well as in the channel.
 *
 * Costs money by default, because three of the four agents run on paid providers. It
 * refuses to start without explicit consent — a key in the environment is not consent.
 */
import { mkdirSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { deterministicKeyPair, generateKeyPair, type KeyPair } from "@freeq-foundry/protocol";
import { FoundryFreeqAgent } from "./agent.js";
import { FoundryLog } from "./log.js";
import { defaultRoster, findSpec, type AgentSpec } from "./roster.js";

const PAID_PROVIDERS = new Set(["anthropic", "openai", "google"]);

interface Options {
  readonly owner: string | undefined;
  readonly channel: string;
  readonly server: string;
  readonly only: readonly string[];
  readonly runId: string;
  readonly workspace: string;
  readonly specPath: string;
  readonly outDir: string;
  readonly maxSpendUsd: string;
  readonly confirmSpend: boolean;
  readonly dryRun: boolean;
  readonly list: boolean;
}

/**
 * Flags that take no value.
 *
 * Needed because `--dry-run --owner x` and `--owner did:plc:x` both have to work: without
 * a boolean set, the parser consumes `--owner` as the value of `--dry-run`. My own usage
 * text used the space-separated form, so accepting only `--key=value` made every example
 * in it wrong.
 */
const BOOLEAN_FLAGS = new Set(["yes-spend-money", "dry-run", "list", "help"]);

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
    // A following token that is itself a flag means this one was used bare.
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
    runId: flags.get("run-id") ?? `foundry-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`,
    workspace: resolve(flags.get("workspace") ?? "workspace"),
    specPath: resolve(flags.get("spec") ?? "docs/specification.md"),
    outDir: resolve(flags.get("out") ?? "out"),
    maxSpendUsd: flags.get("max-spend-usd") ?? "2.00",
    confirmSpend: flags.get("yes-spend-money") === "true",
    dryRun: flags.get("dry-run") === "true",
    list: flags.get("list") === "true",
  };
}

function usage(): void {
  console.log(
    [
      "",
      "  foundry-agent — heterogeneous agents in a live freeq channel",
      "",
      "  Required:",
      "    --owner did:plc:<your-did>      your AT Protocol DID; agents are delegated from it",
      "    --yes-spend-money              explicit consent; three agents use paid providers",
      "",
      "  Common:",
      "    --channel '#foundry'           channel to join (default #foundry)",
      "    --only builder,reviewer        launch a subset by nick",
      "    --max-spend-usd 2.00           hard ceiling across all agents",
      "    --dry-run                      connect and talk, but execute no tools",
      "    --list                         print the roster and exit",
      "",
      "  Environment: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY.",
      "  Ollama must be running locally for the skeptic. Keys are read from the",
      "  environment only — never pass one as a flag, it lands in shell history.",
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
  const roster = options.only.length === 0
    ? defaultRoster()
    : options.only
        .map((key) => findSpec(defaultRoster(), key))
        .filter((spec): spec is AgentSpec => spec !== undefined);

  if (options.list) {
    console.log("");
    for (const spec of defaultRoster()) {
      console.log(`  ${spec.nick.padEnd(11)} ${spec.provider}:${spec.snapshot}`);
      console.log(`  ${" ".repeat(11)} ${spec.blurb}`);
      console.log(`  ${" ".repeat(11)} tools: ${spec.tools.join(", ")}`);
      console.log(`  ${" ".repeat(11)} wants: ${spec.wants.join(", ") || "nothing"}`);
      console.log("");
    }
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
        "  Or run only the local agent, which costs nothing:",
        "",
        `    foundry-agent --owner ${options.owner} --only skeptic`,
        "",
      ].join("\n"),
    );
    return 2;
  }

  for (const spec of roster) {
    const key =
      spec.provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : spec.provider === "openai"
          ? "OPENAI_API_KEY"
          : spec.provider === "google"
            ? "GOOGLE_API_KEY"
            : undefined;
    if (key !== undefined && (process.env[key] ?? "") === "") {
      console.error(`${key} is not set, and ${spec.nick} needs it. Drop it with --only, or set the key.`);
      return 2;
    }
  }

  // A fresh workspace per run, seeded from the starter files so agents have something to
  // read. Shared: they are meant to collide and have to coordinate.
  mkdirSync(options.workspace, { recursive: true });
  if (!existsSync(join(options.workspace, "README.md"))) {
    writeFileSync(
      join(options.workspace, "README.md"),
      [
        "# Webhook Delivery Service",
        "",
        "Three modules are required under `src/`:",
        "",
        "- `signature.mjs` — HMAC-SHA256 `sign(secret, payload, timestamp)` and a",
        "  constant-time `verify(secret, payload, timestamp, signature)`",
        "- `validate.mjs` — `validate(payload)` returning `{ valid, errors }`",
        "- `retry.mjs` — `backoffMs(attempt)` with a ceiling, and `shouldRetry(attempt, status)`",
        "",
        "Plain ES modules. No dependencies and no network — the sandbox has neither.",
        "Acceptance criteria are held externally and are not in this repository.",
      ].join("\n"),
      "utf8",
    );
    mkdirSync(join(options.workspace, "src"), { recursive: true });
  }

  const recorder = deterministicKeyPair("freeq-foundry-recorder");
  const signers = new Map<string, KeyPair>();
  const logPath = join(options.outDir, options.runId, "events.ndjson");
  const log = new FoundryLog({ runId: options.runId, path: logPath, recorder, signers });

  const perAgentMicros = Math.floor(
    (Number(options.maxSpendUsd) * 1_000_000) / Math.max(1, paid.length),
  );

  console.log("");
  console.log(`  Freeq Foundry — ${roster.length} agents → ${options.channel} on ${options.server}`);
  console.log("");
  console.log(`    run          ${options.runId}`);
  console.log(`    owner        ${options.owner}`);
  console.log(`    workspace    ${options.workspace}`);
  console.log(`    log          ${logPath}`);
  if (paid.length > 0) {
    console.log(`    spend cap    $${options.maxSpendUsd} total, $${(perAgentMicros / 1e6).toFixed(2)} per paid agent (hard)`);
  }
  if (options.dryRun) console.log(`    dry run      tools will NOT execute`);
  console.log("");

  const agents: FoundryFreeqAgent[] = [];
  for (const spec of roster) {
    const agent = new FoundryFreeqAgent({
      spec,
      ownerDid: options.owner,
      server: options.server,
      channel: options.channel,
      workspace: options.workspace,
      specPath: options.specPath,
      log,
      maxSpendMicros: PAID_PROVIDERS.has(spec.provider) ? perAgentMicros : Number.MAX_SAFE_INTEGER,
      dryRun: options.dryRun,
    });

    try {
      // Started in sequence, not in parallel: four simultaneous SASL handshakes against
      // prod is rude, and a nick collision is clearer when it happens one at a time.
      await agent.start();
      // The agent's did:key exists only after bot-kit has loaded or minted it, so the
      // signing key is registered now rather than at construction.
      const keyPair = keyPairFor(agent.did);
      log.addSigner(agent.did, keyPair);
      log.record(agent.did, "communication.joined", {
        channel: options.channel,
        nick: spec.nick,
      });
      agents.push(agent);
      console.log(`    ✓ ${spec.nick.padEnd(11)} ${agent.did}`);
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
  console.log(`  Say "@builder start" in the channel to give them something to do.`);
  console.log("  Ctrl+C to stop.");
  console.log("");

  const shutdown = async (reason: string): Promise<void> => {
    console.log(`\n  stopping (${reason})…`);
    await Promise.allSettled(agents.map((agent) => agent.stop(reason)));

    const verification = log.verify();
    const micros = agents.reduce((sum, agent) => sum + agent.spentMicros, 0);
    console.log("");
    console.log(`    events       ${log.events.length}`);
    console.log(`    chain        ${verification.valid ? "verified" : `INVALID (${verification.violations.length})`}`);
    console.log(`    model spend  $${(micros / 1_000_000).toFixed(4)}`);
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
 * A stable Foundry signing key for a freeq DID.
 *
 * Derived from the DID so the same agent signs consistently across restarts. Note this
 * is *not* the freeq identity key — bot-kit owns that, and reading it would mean holding
 * a credential this process has no business holding.
 */
function keyPairFor(did: string): KeyPair {
  return deterministicKeyPair(`foundry-signer:${did}`);
}

void generateKeyPair;

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
