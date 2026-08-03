// createDaemonCLI — Commander-based scaffold for the boring parts of a
// long-running freeq bot daemon (launch/stop/status/doctor/tail). The
// caller supplies a `runDaemon` callback that contains domain logic;
// the scaffold owns the pid file, the --detach fork, the signal
// wiring, and the standard built-in doctor checks.
//
// The scaffold is opinionated about *patterns*, not *behavior*:
// - Two-callback launch model so prompts/persistence can happen in
//   foreground before forking, and the detached child re-runs the
//   same `preflight` idempotently after the fork.
// - Pid file is the source of truth for `stop`/`status`. Stale pid
//   detection is bot-kit's responsibility; bots don't reimplement it.
// - doctor runs built-ins (identity, delegation, server reachability,
//   provenance) first, then caller's checks. Order matters; bots
//   layering on top can assume the built-ins ran.
//
// What the scaffold does NOT do:
// - Prompt for user input (bots own that, in `preflight`).
// - Persist a config.json (bots own theirs).
// - Touch did:key rotation (sensitive enough that v1 leaves it to bots).
// - Reach into the SDK or FreeqBot (this layer is purely lifecycle).
import { Command } from "commander";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { loadDelegation } from "./delegation.js";
import { loadOrCreateIdentity } from "./identity.js";
/** Construct the Commander program. The returned `Command` is the root
 *  — bot-specific subcommands can be added via `.command(...)`. Call
 *  `.parseAsync(process.argv)` to run.
 *
 *  v1 commands: launch, stop, status, doctor, tail. */
export function createDaemonCLI(opts) {
    const program = new Command();
    program.name(opts.name).version("0.1.0");
    registerLaunch(program, opts);
    registerStop(program, opts);
    registerStatus(program, opts);
    registerDoctor(program, opts);
    registerTail(program, opts);
    return program;
}
// ── launch ─────────────────────────────────────────────────────────────
function registerLaunch(program, opts) {
    const cmd = program
        .command("launch")
        .description(`Launch the ${opts.name} daemon. Use --detach to fork into the background.`)
        .option("--detach", `Fork into the background (logs to ${opts.paths.daemonLog}). Prompts complete in the foreground first.`);
    for (const flag of opts.launchOptions ?? []) {
        cmd.option(flag.flags, flag.description);
    }
    cmd.action(async (parsed) => {
        // Preflight: prompts + config persistence happen here in foreground
        // FIRST. The detached child re-runs this idempotently.
        const daemonOpts = opts.preflight
            ? await opts.preflight(parsed)
            : parsed;
        if (parsed.detach) {
            // Fork a fresh `<name> launch` subprocess (without --detach).
            // Parent exits after printing the child pid; child writes its
            // own pid file inside the spawned action.
            await mkdir(opts.paths.dir, { recursive: true, mode: 0o700 });
            const logFh = await open(opts.paths.daemonLog, "a", 0o600);
            const args = process.argv.slice(2).filter((a) => a !== "--detach");
            const child = spawn(process.argv0, [process.argv[1], ...args], {
                detached: true,
                stdio: ["ignore", logFh.fd, logFh.fd],
                env: { ...process.env, [`${envPrefix(opts.name)}DETACHED`]: "1" },
            });
            child.unref();
            await logFh.close();
            console.log(`${opts.name} launched (pid ${child.pid}); logs → ${opts.paths.daemonLog}`);
            console.log(`  ${opts.name} status   — show live state`);
            console.log(`  ${opts.name} stop     — clean shutdown`);
            return;
        }
        // Foreground: write pid, run daemon, cleanup on exit.
        await mkdir(opts.paths.dir, { recursive: true, mode: 0o700 });
        await writeFile(opts.paths.daemonPid, String(process.pid) + "\n", {
            mode: 0o600,
        });
        const handle = await opts.runDaemon(daemonOpts);
        // Signal handlers: scaffold owns these so the bot doesn't have to.
        let stopping = false;
        const shutdown = async (sig) => {
            if (stopping)
                return;
            stopping = true;
            console.log(`\n[${sig}] shutting down...`);
            try {
                await handle.stop(`signal ${sig}`);
            }
            catch (err) {
                console.error(`[${sig}] stop failed: ${err.message}`);
            }
            try {
                await unlink(opts.paths.daemonPid);
            }
            catch {
                // already gone
            }
            process.exit(0);
        };
        process.once("SIGINT", () => void shutdown("SIGINT"));
        process.once("SIGTERM", () => void shutdown("SIGTERM"));
        // Block forever — shutdown is driven by signals.
        await new Promise(() => { });
    });
}
// ── stop ───────────────────────────────────────────────────────────────
function registerStop(program, opts) {
    program
        .command("stop")
        .description("Stop the running daemon (clean SIGTERM).")
        .action(async () => {
        const pid = await readPidIfAlive(opts.paths.daemonPid);
        if (pid === null) {
            console.log("No daemon is running.");
            // If pid file exists but the pid is dead, clean it up.
            try {
                await unlink(opts.paths.daemonPid);
            }
            catch {
                // already gone
            }
            return;
        }
        try {
            process.kill(pid, "SIGTERM");
            console.log(`Sent SIGTERM to pid ${pid}.`);
        }
        catch (err) {
            const code = err.code;
            if (code === "ESRCH") {
                console.log(`Pid ${pid} is gone; cleaning up stale pid file.`);
                await unlink(opts.paths.daemonPid).catch(() => { });
            }
            else {
                throw err;
            }
        }
    });
}
// ── status ─────────────────────────────────────────────────────────────
function registerStatus(program, opts) {
    program
        .command("status")
        .description(`Show ${opts.name} daemon status.`)
        .action(async () => {
        const pid = await readPidIfAlive(opts.paths.daemonPid);
        const did = await safeReadAgentDid(opts.paths.agentKey);
        const cert = await loadDelegation({ certPath: opts.paths.delegation }).catch(() => null);
        console.log(`─── ${opts.name} status ───`);
        console.log(`pid file:       ${opts.paths.daemonPid}`);
        console.log(`daemon:         ${pid !== null ? `running (pid ${pid})` : "not running"}`);
        console.log(`agent DID:      ${did ?? "(no agent.key)"}`);
        console.log(`delegation:     ${cert ? (cert.signature ? "signed" : "unsigned (v1.0)") : "(none)"}`);
        if (opts.statusExtras) {
            const extras = await opts.statusExtras();
            for (const line of extras)
                console.log(line);
        }
        if (pid !== null && did && opts.actorStatusUrl) {
            const url = opts.actorStatusUrl(did);
            try {
                const resp = await fetch(url);
                if (resp.ok) {
                    const json = (await resp.json());
                    console.log(`actor.online:   ${json.online}`);
                    console.log(`actor.nick:     ${json.nick ?? "(none)"}`);
                    const provenance = json.provenance;
                    if (provenance) {
                        console.log(`provenance:     verified=${provenance.verified} (${provenance.reason ?? "—"})`);
                    }
                }
                else {
                    console.log(`actor api:      ${resp.status} ${resp.statusText}`);
                }
            }
            catch (e) {
                console.log(`actor api:      error: ${e.message}`);
            }
        }
    });
}
// ── doctor ─────────────────────────────────────────────────────────────
function registerDoctor(program, opts) {
    program
        .command("doctor")
        .description("Sanity-check identity, delegation, server reachability, and bot-specific checks.")
        .action(async () => {
        console.log(`─── ${opts.name} doctor ───`);
        let problems = 0;
        let warnings = 0;
        const print = (name, r) => {
            if (r.ok === true) {
                console.log(`  ✓ ${name}${r.detail ? `: ${r.detail}` : ""}`);
            }
            else if (r.ok === "warn") {
                console.log(`  ⚠ ${name}: ${r.reason}`);
                warnings++;
            }
            else {
                console.log(`  ✗ ${name}: ${r.reason}`);
                problems++;
            }
        };
        const builtIns = [
            {
                name: "agent identity",
                run: async () => {
                    const did = await safeReadAgentDid(opts.paths.agentKey);
                    return did
                        ? { ok: true, detail: did }
                        : {
                            ok: false,
                            reason: `no agent.key at ${opts.paths.agentKey} — run '${opts.name} launch' to generate`,
                        };
                },
            },
            {
                name: "delegation",
                run: async () => {
                    const cert = await loadDelegation({
                        certPath: opts.paths.delegation,
                    }).catch((e) => ({ __err: e.message }));
                    if (cert && "__err" in cert) {
                        return { ok: false, reason: `delegation malformed: ${cert.__err}` };
                    }
                    if (!cert) {
                        return {
                            ok: false,
                            reason: `no delegation.json at ${opts.paths.delegation}`,
                        };
                    }
                    const did = await safeReadAgentDid(opts.paths.agentKey);
                    if (did && cert.bot_did !== did) {
                        return {
                            ok: false,
                            reason: `delegation.bot_did ≠ agent.did (${cert.bot_did} vs ${did})`,
                        };
                    }
                    return {
                        ok: true,
                        detail: `${cert.signature ? "signed" : "unsigned (v1.0)"} (bot=${cert.bot_did}, creator=${cert.creator_did})`,
                    };
                },
            },
        ];
        if (opts.actorStatusUrl) {
            builtIns.push({
                name: "server actor record",
                run: async () => {
                    const did = await safeReadAgentDid(opts.paths.agentKey);
                    if (!did)
                        return { ok: "warn", reason: "no identity to query" };
                    try {
                        const resp = await fetch(opts.actorStatusUrl(did));
                        if (!resp.ok) {
                            return { ok: false, reason: `${resp.status} ${resp.statusText}` };
                        }
                        const json = (await resp.json());
                        const online = json.online === true ? "online" : "offline";
                        const provenance = json.provenance;
                        const verified = provenance?.verified
                            ? "verified"
                            : `unverified (${provenance?.reason ?? "—"})`;
                        return { ok: true, detail: `${online}, provenance ${verified}` };
                    }
                    catch (e) {
                        return {
                            ok: false,
                            reason: `actor api unreachable: ${e.message}`,
                        };
                    }
                },
            });
        }
        for (const c of builtIns) {
            try {
                print(c.name, await c.run());
            }
            catch (e) {
                print(c.name, { ok: false, reason: e.message });
            }
        }
        for (const c of opts.doctorChecks ?? []) {
            try {
                print(c.name, await c.run());
            }
            catch (e) {
                print(c.name, { ok: false, reason: e.message });
            }
        }
        console.log("");
        if (problems > 0) {
            console.log(`${problems} problem(s)${warnings > 0 ? `, ${warnings} warning(s)` : ""}.`);
            process.exit(1);
        }
        else if (warnings > 0) {
            console.log(`All required checks passed (${warnings} warning(s)).`);
        }
        else {
            console.log("All checks passed.");
        }
    });
}
// ── tail ───────────────────────────────────────────────────────────────
function registerTail(program, opts) {
    program
        .command("tail")
        .description(`Stream the daemon log (${opts.paths.daemonLog}).`)
        .option("-n, --lines <n>", "show the last N lines first", "40")
        .action(async (cmdOpts) => {
        const lines = cmdOpts.lines ?? "40";
        const proc = spawn("tail", ["-F", "-n", lines, opts.paths.daemonLog], {
            stdio: ["ignore", "inherit", "inherit"],
        });
        proc.on("error", (err) => {
            console.error(`tail failed: ${err.message}`);
            process.exit(1);
        });
        process.once("SIGINT", () => proc.kill("SIGTERM"));
    });
}
// ── helpers ────────────────────────────────────────────────────────────
/** Read pid file. Returns null if missing, malformed, or pointing at a
 *  process that no longer exists. */
export async function readPidIfAlive(pidPath) {
    let raw;
    try {
        raw = await readFile(pidPath, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return null;
        throw err;
    }
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0)
        return null;
    try {
        // Signal 0: no-op, just checks process existence.
        process.kill(pid, 0);
        return pid;
    }
    catch (err) {
        if (err.code === "ESRCH")
            return null;
        // EPERM: process exists but we lack permission to signal — treat as
        // alive (better than a false negative).
        return pid;
    }
}
/** Read agent.key and derive the DID, without re-creating if missing. */
async function safeReadAgentDid(seedPath) {
    try {
        await stat(seedPath);
    }
    catch {
        return null;
    }
    const id = await loadOrCreateIdentity({ seedPath }).catch(() => null);
    return id?.did ?? null;
}
/** Turn "freeqcc" → "FREEQCC_", "swarm-coordinator" → "SWARM_COORDINATOR_". */
function envPrefix(name) {
    return name.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase() + "_";
}
//# sourceMappingURL=daemon-cli.js.map