import { Command } from "commander";
/** Discriminated result returned by a doctor check. */
export type DoctorResult = {
    ok: true;
    detail?: string;
} | {
    ok: false;
    reason: string;
} | {
    ok: "warn";
    reason: string;
};
/** One doctor check. `name` is shown in the output; `run` is awaited. */
export interface DoctorCheck {
    name: string;
    run: () => Promise<DoctorResult>;
}
export interface DaemonPaths {
    /** Directory for state (~/.mybot/). Created with mode 0700 if missing. */
    dir: string;
    /** Pid file path (~/.mybot/daemon.pid). */
    daemonPid: string;
    /** Daemon log path (~/.mybot/daemon.log) — used by --detach + tail. */
    daemonLog: string;
    /** Agent seed file path — used by the built-in identity doctor check. */
    agentKey: string;
    /** Delegation cert path — used by the built-in delegation check. */
    delegation: string;
}
export interface DaemonHandle {
    /** Called by the scaffold on SIGINT/SIGTERM. Should shut down cleanly. */
    stop(reason: string): Promise<void>;
}
/** What the launch action passes to runDaemon after preflight finishes. */
export type DaemonOpts = Record<string, any>;
export interface CreateDaemonCLIOptions<O extends DaemonOpts = DaemonOpts> {
    /** Bot name. Used in messages + as the default program name. */
    name: string;
    /** Paths the scaffold reads/writes on the bot's behalf. */
    paths: DaemonPaths;
    /** Daemon entry point. Runs only in the daemon process (foreground or
     *  detached child). Returns a handle so the scaffold can ask it to
     *  shut down on SIGINT/SIGTERM. */
    runDaemon: (opts: O) => Promise<DaemonHandle>;
    /** Optional pre-launch hook. Runs in BOTH the foreground (before fork)
     *  and the detached child (after fork). Must be idempotent: a re-run
     *  should see the persisted state from the first run and skip prompts.
     *  Returns the options object passed to runDaemon.
     *
     *  If omitted, runDaemon receives the parsed Commander options
     *  directly. */
    preflight?: (parsed: Record<string, unknown>) => Promise<O>;
    /** Extra `launch` command flags. Caller reads them from runDaemon's
     *  opts (or from preflight's `parsed` arg). */
    launchOptions?: Array<{
        flags: string;
        description: string;
    }>;
    /** Bot-specific doctor checks, appended after built-ins. */
    doctorChecks?: DoctorCheck[];
    /** Extra lines appended to `status` output. Useful for telemetry. */
    statusExtras?: () => Promise<string[]>;
    /** Optional REST URL to query for live actor state. Receives the
     *  bot's resolved did:key. If omitted, `status` + `doctor` skip the
     *  provenance check. */
    actorStatusUrl?: (did: string) => string;
}
/** Construct the Commander program. The returned `Command` is the root
 *  — bot-specific subcommands can be added via `.command(...)`. Call
 *  `.parseAsync(process.argv)` to run.
 *
 *  v1 commands: launch, stop, status, doctor, tail. */
export declare function createDaemonCLI<O extends DaemonOpts = DaemonOpts>(opts: CreateDaemonCLIOptions<O>): Command;
/** Read pid file. Returns null if missing, malformed, or pointing at a
 *  process that no longer exists. */
export declare function readPidIfAlive(pidPath: string): Promise<number | null>;
//# sourceMappingURL=daemon-cli.d.ts.map