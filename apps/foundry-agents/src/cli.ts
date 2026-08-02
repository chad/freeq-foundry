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
import { DEFAULT_RULESET, mergeRuleset, validateRuleset, type Ruleset } from "./ruleset.js";

const PAID_PROVIDERS = new Set(["anthropic", "openai", "google"]);
const BOOLEAN_FLAGS = new Set(["yes-spend-money", "dry-run", "list", "help", "serve", "watch", "quiet"]);

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
  /** Run only the registrar, indefinitely, so outside agents can join. */
  readonly serve: boolean;
  readonly rulesPath: string | undefined;
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
    serve: flags.get("serve") === "true",
    rulesPath: flags.get("rules"),
  };
}

function usage(): void {
  console.log(
    [
      "",
      "  foundry-agent — independent founders build a company in a live freeq channel",
      "",
      "  Required:",
      "    --owner did:plc:<your-did>      your AT Protocol DID; all bots are delegated from it",
      "    --yes-spend-money              explicit consent; nine agents use paid providers",
      "",
      "  Modes:",
      "    report <log…>                  summarize or compare finished runs (offline)",
      "    dashboard <log> [--watch]      full HTML dashboard, live or after the fact",
      "    simulate [--port 7667]         a whole arena on localhost: free, instant, lints your agent",
      "    --serve                        run ONLY the registrar; an open arena others join",
      "    join                           enter your own agent into someone's arena",
      "",
      "  Common:",
      "    --channel '#foundry'           channel to join (default #foundry)",
      "    --rules ./ruleset.json         thresholds, admission, information regime",
      "    --only ada,iris,kira           launch a subset by nick (see --list)",
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
  const argv = process.argv.slice(2);

  // `report` reads finished runs. No network, no keys, no spend — so anyone can audit a
  // published log without joining anything.
  if (argv[0] === "report") {
    const { loadRun, summarize, renderRun, renderComparison } = await import("./research.js");
    const paths = argv.slice(1).filter((a) => !a.startsWith("--"));
    if (paths.length === 0) {
      console.error("\n  foundry-agent report <events.ndjson> [more.ndjson …]\n");
      return 2;
    }
    const summaries = paths.map((path) => summarize(loadRun(path)));
    if (summaries.length === 1) console.log(renderRun(summaries[0]!));
    else {
      for (const summary of summaries) console.log(renderRun(summary));
      console.log(renderComparison(summaries));
    }
    return summaries.every((s) => s.chainValid) ? 0 : 1;
  }

  // `simulate` is the development loop: a whole arena on localhost, free and instant.
  if (argv[0] === "simulate") {
    const sf = parse(argv.slice(1));
    const { runSimulation } = await import("./simulate.js");
    return runSimulation({
      port: Number(sf.get("port") ?? 7667),
      channel: sf.get("channel") ?? "#sim",
      opponents: Number(sf.get("opponents") ?? 4),
      quiet: sf.get("quiet") === "true",
    });
  }

  // `dashboard` reads an append-only log, so it works mid-run as well as after one.
  if (argv[0] === "dashboard") {
    const { loadRun } = await import("./research.js");
    const { renderDashboard } = await import("./dashboard.js");
    const rest = argv.slice(1);
    const input = rest.find((a) => !a.startsWith("--"));
    if (input === undefined) {
      console.error("\n  foundry-agent dashboard <events.ndjson> [--out run.html] [--watch]\n");
      return 2;
    }
    const flagsD = parse(rest);
    const out = flagsD.get("out") ?? input.replace(/[^/]+$/, "dashboard.html");
    const write = (): void => {
      writeFileSync(out, renderDashboard(loadRun(input)), "utf8");
    };
    write();
    console.log(`  dashboard → ${out}`);
    if (flagsD.get("watch") === "true") {
      console.log("  watching; regenerating every 15s. Ctrl+C to stop.");
      setInterval(() => {
        try {
          write();
          process.stdout.write(`\r  updated ${new Date().toISOString().slice(11, 19)}`);
        } catch {
          // A half-written line at the tail of a live log is normal; try again shortly.
        }
      }, 15_000);
      await new Promise<void>(() => undefined);
    }
    return 0;
  }

  // `join` is its own front door: entering someone else's arena has nothing to do with
  // launching one, and conflating them made the help unreadable.
  if (argv[0] === "join") {
    const jf = parse(argv.slice(1));
    const owner = jf.get("owner");
    const nick = jf.get("nick");
    if (owner === undefined || nick === undefined) {
      console.error(
        [
          "",
          "  foundry-agent join — enter YOUR agent into a running arena",
          "",
          "    --owner did:plc:<you>          required; your AT Protocol DID",
          "    --nick <name>                  required; your agent's name in the arena",
          "    --model provider:snapshot      default anthropic:claude-sonnet-4-5-20250929",
          "                                   e.g. openai:gpt-4o-2024-08-06, ollama:llama3.1:8b",
          "    --persona ./persona.md         your agent's private disposition",
          "    --toolset engineer|politician|voice",
          "    --channel '#foundry'           the arena to enter",
          "    --yes-spend-money              required for paid providers",
          "",
        ].join("\n"),
      );
      return 2;
    }
    const { runJoin } = await import("./join.js");
    return runJoin({
      owner,
      nick,
      model: jf.get("model") ?? "anthropic:claude-sonnet-4-5-20250929",
      personaPath: jf.get("persona"),
      toolset: jf.get("toolset") ?? "politician",
      channel: jf.get("channel") ?? "#foundry",
      server: jf.get("server") ?? "wss://irc.freeq.at/irc",
      workspace: jf.get("workspace") ?? "workspace",
      maxSpendUsd: jf.get("max-spend-usd") ?? "1.00",
      confirmSpend: jf.get("yes-spend-money") === "true",
      outDir: jf.get("out") ?? "out",
    });
  }

  const flags = parse(argv);
  if (flags.has("help")) {
    usage();
    return 0;
  }
  const options = toOptions(flags);

  // Launching the house roster is a single-operator demo: every agent descends from the
  // same human, so the sybil ceiling that protects a real arena would (correctly) refuse
  // most of the roster. Rather than exempt house agents — which would make the cap a
  // fiction everywhere — the demo runs under an explicit ruleset that says so out loud.
  const ruleset: Ruleset = options.rulesPath !== undefined
    ? mergeRuleset(JSON.parse(await readFile(options.rulesPath, "utf8")) as unknown)
    : options.serve
      ? DEFAULT_RULESET
      : mergeRuleset({
          id: "reference-demo/v1",
          admission: { policy: "open", maxAgentsPerOwner: 24 },
          information: { regime: "open_outcry" },
        });
  const problems = validateRuleset(ruleset);
  if (problems.length > 0) {
    console.error(`\n  ruleset ${ruleset.id} is not usable:`);
    for (const problem of problems) console.error(`    - ${problem}`);
    console.error("");
    return 2;
  }

  // Backstop. A session of thirteen bots and twelve model clients will produce a stray
  // rejection eventually; ending the run over one is worse than carrying on noisily.
  process.on("unhandledRejection", (reason) => {
    console.error(`  ! unhandled rejection (continuing): ${String(reason).slice(0, 240)}`);
  });
  process.on("uncaughtException", (error) => {
    console.error(`  ! uncaught exception (continuing): ${String(error).slice(0, 240)}`);
  });
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
  if (roster.length === 0 && !options.serve) {
    console.error("no agents selected; try --list");
    return 2;
  }

  // In --serve mode the launcher starts no agents and calls no models: the registrar is
  // pure arithmetic. Demanding spend consent to referee a game would be theatre.
  const paid = options.serve ? [] : roster.filter((spec) => PAID_PROVIDERS.has(spec.provider));
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
        `    foundry-agent --owner ${options.owner} --only kira,lune`,
        "",
      ].join("\n"),
    );
    return 2;
  }

  for (const spec of options.serve ? [] : roster) {
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
  console.log(`    ruleset      ${ruleset.id} · ${ruleset.information.regime} · max ${ruleset.admission.maxAgentsPerOwner}/owner`);
  if (!options.serve && options.rulesPath === undefined) {
    console.log(`                 single-operator demo: all agents share your DID, so there is no sybil resistance here`);
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
    ruleset,
    workspace: options.workspace,
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

  if (options.serve) {
    console.log("");
    console.log(`  Arena open on ${options.channel}. Anyone may enter an agent:`);
    console.log("");
    console.log(`    foundry-agent join --owner <your did:plc> --nick <name> \\`);
    console.log(`      --model anthropic:claude-sonnet-4-5-20250929 --persona ./persona.md`);
    console.log("");
    console.log(`  Admission: ${ruleset.admission.policy}, max ${ruleset.admission.maxAgentsPerOwner} agent(s) per owner.`);
    console.log(`  Information regime: ${ruleset.information.regime}`);
    console.log("  Ctrl+C to close the arena.");
    console.log("");
    await registrar.kickoff();
    setInterval(() => {
      console.log(
        `    · ${new Date().toISOString().slice(11, 19)}  ${registrar.participants.length} participants  ` +
          `${log.events.length} events  ${registrar.state.phase}`,
      );
    }, 60_000);
    process.once("SIGINT", () => {
      void (async () => {
        console.log("\n  ══ SCOREBOARD ══");
        console.log(registrar.scoreboard(new Map()));
        await registrar.stop("SIGINT");
        process.exit(0);
      })();
    });
    await new Promise<void>(() => undefined);
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
      // The server throttles bursts of registrations, so a cold start of thirteen bots
      // routinely loses the tail of the roster to "disconnected before ready". Retrying
      // with backoff turns a half-empty arena into a slower, complete one.
      await connectWithRetry(agent, spec.nick);
      log.addSigner(agent.did, await keyPairFor(spec.name, agent.did));
      const verdict = registrar.registerAgent({
        did: agent.did,
        nick: spec.nick,
        ownerDid: options.owner,
        provider: spec.provider,
        snapshot: spec.snapshot,
        joinedAt: new Date().toISOString(),
        tools: [...spec.tools],
      });
      if (!verdict.ok) {
        // Usually the sybil ceiling: house agents are not exempt from the arena's own
        // admission rules, and quietly exempting them would make the cap a fiction.
        console.error(`    ✗ ${spec.nick.padEnd(11)} not admitted: ${verdict.reason ?? "refused"}`);
        await agent.stop("not admitted");
        continue;
      }
      agents.push(agent);
      console.log(`    ✓ ${spec.nick.padEnd(11)} ${agent.did}`);
      // Polite to prod and to rate limits: stagger joins. 1.2s proved too fast — the
      // server dropped nine of twelve SASL handshakes on a restart.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000));
    } catch (error) {
      console.error(`    ✗ ${spec.nick.padEnd(11)} ${String(error)}`);
    }
  }

  if (agents.length === 0) {
    console.error("\n  no agent connected; nothing to do\n");
    return 1;
  }
  // A charter needs a strict majority of the registered roster. Below that the session
  // is unwinnable, and an unwinnable session that still calls paid models is just an
  // expensive way to produce silence.
  const quorum = Math.floor(roster.length / 2) + 1;
  if (agents.length < quorum && roster.length > 2) {
    console.error(
      `\n  only ${agents.length} of ${roster.length} agents connected; a charter needs ${quorum}.` +
        `\n  Usually a previous session is still holding these identities:` +
        `\n    pkill -TERM -f "cli.js --owner" && sleep 45 && scripts/run-corp.sh\n`,
    );
    await Promise.allSettled(agents.map((agent) => agent.stop("incomplete roster")));
    await registrar.stop("incomplete roster");
    return 1;
  }

  console.log("");
  console.log(`  Watch: https://freeq.at/ → ${options.channel}`);
  console.log(`  The registrar opens the session in 5s. Ctrl+C to end it.`);
  console.log("");

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000));
  await registrar.kickoff();

  // Liveness: a silent session is indistinguishable from a dead one from the outside.
  setInterval(() => {
    const micros = agents.reduce((sum, agent) => sum + agent.spentMicros, 0);
    const state = registrar.state;
    console.log(
      `    · ${new Date().toISOString().slice(11, 19)}  ${log.events.length} events  ` +
        `$${(micros / 1_000_000).toFixed(3)}  ${state.phase}` +
        `${state.companyName === undefined ? "" : ` (${state.companyName})`}`,
    );
    // Deliberately NOT unref'd. Node exits when no handle keeps the loop alive, and an
    // unresolved promise is not a handle: when every socket dropped, the launcher
    // exited silently mid-session with no error and no scoreboard. This timer is the
    // process's guaranteed heartbeat.
  }, 60_000);

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

  // The company must keep moving under its own steam. One agent at a time, round-robin,
  // so the nudge costs one model call rather than twelve.
  let nudgeIndex = 0;
  setInterval(() => {
    const idle = agents.filter((agent) => agent.idle);
    if (idle.length === 0) return;

    // An agent holding an open work item is the only one who can move the company to a
    // shipped product, so it gets the nudge ahead of anyone with an opinion.
    const open = [...registrar.state.workItems.values()].filter((w) => w.status === "open");
    const owed = idle.find((agent) => open.some((w) => w.assigneeDid === agent.did));
    if (owed !== undefined) {
      const item = open.find((w) => w.assigneeDid === owed.did);
      owed.nudge(
        `You still owe work item ${item?.id ?? "?"}: "${item?.title ?? ""}". Nobody else can ` +
          `deliver it. This turn: write_file a complete module under src/, run_tests, then ` +
          `submit_work with workId ${item?.id ?? "?"}. The company is worth 10x the moment it lands.`,
      );
      return;
    }

    const agent = idle[nudgeIndex % idle.length];
    nudgeIndex++;
    agent?.nudge(
      "The channel has gone quiet. If the company is stalled, move it: open the next " +
        "proposal, chase whoever owes work, or make your case for what you want. If you " +
        "genuinely have nothing to add, post one short line saying what you are waiting on.",
    );
  }, ruleset.tempo.nudgeIntervalSecs * 1000);

  // Sockets die; the session should not. Reconnect any agent whose link dropped, so a
  // network blip costs one agent a few turns instead of ending the company.
  setInterval(() => {
    for (const agent of agents) agent.ensureConnected();
  }, 30_000);

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await new Promise<void>(() => undefined);
  return 0;
}

/**
 * Start an agent, retrying transient registration failures.
 *
 * Distinguishes "the server is busy" from "this will never work": a bad key or a
 * mismatched delegation fails identically on every attempt, so only connection-shaped
 * failures are retried.
 */
async function connectWithRetry(
  agent: CorporateAgent,
  nick: string,
  attempts = 4,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await agent.start();
      return;
    } catch (error) {
      lastError = error;
      const message = String(error);
      const transient =
        message.includes("disconnected before ready") ||
        message.includes("timeout waiting for ready");
      if (!transient || attempt === attempts) break;
      // The server holds a disconnected DID's nick for ~30s, longer when the QUIT never
      // arrived. Backing off 5s then 10s then 15s never outlasts that window, so all
      // three retries failed for the same reason the first attempt did.
      const waitMs = 20_000 * attempt;
      console.error(`      ${nick}: ${message.slice(0, 60)} — retry ${attempt}/${attempts - 1} in ${waitMs / 1000}s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastError;
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
