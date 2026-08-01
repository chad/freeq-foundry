#!/usr/bin/env node
/**
 * `foundry` — run a scenario end to end and produce the artifacts.
 *
 * The point of this binary is that the platform is *demonstrable*, not merely
 * tested. It runs a real (small) experiment: a population is admitted, proposes a
 * capability grant, votes, executes it, works under that authority, and ships to an
 * evaluator it cannot influence. Then it writes out the signed log, the
 * projections, and an evidence-backed report.
 *
 * No model is involved, so it costs nothing and produces the same bytes every time.
 *
 * Spec: §57 operational runbook.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  RunValidity,
  deterministicKeyPair,
  verifyChain,
} from "@freeq-foundry/protocol";
import {
  builderAgent,
  institutionalistAgent,
  weakSaboteurAgent,
} from "@freeq-foundry/agents";
import {
  executeRun,
  webhookScenario,
  type ParticipantSpec,
  type Scenario,
} from "@freeq-foundry/controller";
import { checkRegistry, computeMetrics, generateReport } from "@freeq-foundry/observability";

interface Options {
  readonly runId: string;
  readonly arm: string;
  readonly enforce: boolean;
  readonly saboteur: boolean;
  readonly outDir: string;
  readonly quiet: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (match !== null) flags.set(match[1] as string, match[2] ?? "true");
  }
  const enforce = flags.get("no-enforce") !== "true";
  return {
    runId: flags.get("run-id") ?? `run-${enforce ? "enforced" : "unenforced"}-001`,
    arm: flags.get("arm") ?? (enforce ? "capability_enforced" : "unenforced_governance"),
    enforce,
    saboteur: flags.get("saboteur") === "true",
    outDir: resolve(flags.get("out") ?? "out"),
    quiet: flags.get("quiet") === "true",
  };
}

const scenario: Scenario = webhookScenario();

/**
 * Four independent human operators, each with one agent.
 *
 * Lineage pseudonyms are no longer asserted here: they are derived from the
 * verified credential chain at admission. A scenario cannot claim a lineage it
 * cannot prove.
 */
function population(withSaboteur: boolean): readonly ParticipantSpec[] {
  const alice = deterministicKeyPair("alice");
  const bob = deterministicKeyPair("bob");
  const carol = deterministicKeyPair("carol");
  const mallory = deterministicKeyPair("mallory");

  const base: ParticipantSpec[] = [
    {
      keyPair: alice,
      adapter: builderAgent("alice-builder", alice.did),
      humanRoot: deterministicKeyPair("human-one"),
      declaredAutonomy: "autonomous",
    },
    {
      keyPair: bob,
      adapter: institutionalistAgent("bob-institutionalist"),
      humanRoot: deterministicKeyPair("human-two"),
      declaredAutonomy: "autonomous",
    },
    {
      keyPair: carol,
      adapter: builderAgent("carol-builder", alice.did),
      humanRoot: deterministicKeyPair("human-three"),
      declaredAutonomy: "autonomous",
    },
  ];

  if (withSaboteur) {
    base.push({
      keyPair: mallory,
      adapter: weakSaboteurAgent("mallory-saboteur"),
      humanRoot: deterministicKeyPair("human-four"),
      declaredAutonomy: "autonomous",
    });
  }
  return base;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const log = options.quiet ? () => undefined : (line: string) => console.log(line);

  // The registry is checked before anything runs. A violated multiplicity policy
  // invalidates the analysis, so failing here is better than producing a report
  // nobody should trust.
  const registryProblems = checkRegistry();
  if (registryProblems.length > 0) {
    console.error("metric registry is invalid:");
    for (const problem of registryProblems) console.error(`  - ${problem}`);
    return 1;
  }

  const recorder = deterministicKeyPair("recorder");
  const controller = deterministicKeyPair("controller");
  const evaluator = deterministicKeyPair("evaluator");

  log(`Freeq Foundry — ${options.runId}`);
  log(`  scenario   ${scenario.scenarioId}`);
  log(`  arm        ${options.arm}`);
  log(`  enforce    ${options.enforce ? "capability checks enforced" : "checks bypassed (Condition F)"}`);
  log(`  population ${population(options.saboteur).length} deterministic agents`);
  log("");

  const started = Date.now();
  const result = await executeRun({
    runId: options.runId,
    scenario,
    participants: population(options.saboteur),
    recorder,
    controller,
    evaluator,
    arm: options.arm,
    enforceCapabilities: options.enforce,
    confirmatory: false,
  });
  const wallMs = Date.now() - started;

  const events = [];
  for await (const event of result.store.read(result.runId)) events.push(event);

  // Verify what we produced. A run whose own log does not verify is not a result.
  const verification = verifyChain(events, {
    runId: result.runId,
    recorderDid: recorder.did,
  });

  log(`  ticks       ${result.ticks}`);
  log(`  events      ${result.eventCount}`);
  log(`  outcome     ${result.shipped ? "SHIPPED" : "did not ship"}`);
  log(`  termination ${result.terminationReason}`);
  log(
    `  run clock   ${result.timeToReleaseMs === undefined ? "—" : `${(result.timeToReleaseMs / 3_600_000).toFixed(2)} h to release`}`,
  );
  log(`  chain       ${verification.valid ? "verified" : `INVALID (${verification.violations.length} violations)`}`);
  log(`  real time   ${wallMs} ms`);
  log("");

  const snapshot = result.state;
  const mainFiles = result.repository.checkout("main") ?? new Map<string, string>();
  const metrics = computeMetrics(snapshot);
  const primary = metrics.find((m) => m.tier === "primary");

  log("  primary outcome");
  log(
    `    restricted time to release  ${primary?.value === undefined ? "—" : `${(primary.value / 3_600_000).toFixed(2)} h`}`,
  );
  log("");
  log("  organization");
  log(`    constitution version      ${snapshot.constitution.version}`);
  log(`    proposals                 ${snapshot.proposals.byId.size}`);
  log(`    capability grants         ${snapshot.capabilities.grants.size}`);
  log(`    actions denied            ${snapshot.capabilities.deniedActions}`);
  log("");

  const report = generateReport({
    runId: result.runId,
    snapshot,
    events,
    recorderDid: recorder.did,
    arm: options.arm,
  });

  // The export bundle (§33.9). Everything needed to check the claims.
  const dir = join(options.outDir, result.runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "events.ndjson"),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
    "utf8",
  );
  writeFileSync(join(dir, "report.md"), report, "utf8");
  writeFileSync(
    join(dir, "manifest.json"),
    `${JSON.stringify(result.manifest, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "metrics.json"),
    `${JSON.stringify(metrics, null, 2)}\n`,
    "utf8",
  );

  // The product itself, plus the signed evaluator verdicts. A reader can run the
  // code and check the verdict independently.
  for (const [path, content] of mainFiles) {
    const target = join(dir, "product", path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  writeFileSync(
    join(dir, "evaluations.json"),
    `${JSON.stringify(result.evaluations, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "commit-provenance.json"),
    `${JSON.stringify(result.repository.provenanceOf("main"), null, 2)}\n`,
    "utf8",
  );

  log(`  wrote ${join(dir, "events.ndjson")}`);
  log(`  wrote ${join(dir, "report.md")}`);
  log(`  wrote ${join(dir, "manifest.json")}`);
  log(`  wrote ${join(dir, "metrics.json")}`);
  log(`  wrote ${join(dir, "evaluations.json")}`);
  log(`  wrote ${join(dir, "commit-provenance.json")}`);
  log(`  wrote ${join(dir, "product")}/ (${mainFiles.size} files)`);

  if (!verification.valid) {
    console.error("\nthe produced chain does not verify; this is a harness bug");
    return 1;
  }
  if (result.validity !== RunValidity.VALID) {
    console.error(`\nrun is ${result.validity} and must be replaced rather than scored`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
