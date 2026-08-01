/**
 * Container-backed sandbox.
 *
 * §31 requires containers or microVMs, and ADR-0002 noted Node cannot provide
 * in-process isolation. `NodeSubprocessSandbox` is honest about being process-level
 * and insufficient for untrusted code; this is the runner that closes that gap, and it
 * implements the same interface so substituting it is a configuration change.
 *
 * What it adds over a subprocess:
 *
 *   - **A separate kernel namespace.** A subprocess shares the filesystem outside its
 *     cwd; a container does not.
 *   - **`--network=none`.** The strongest single control here. Generated code that
 *     cannot reach the network cannot exfiltrate a secret it happens to find, cannot
 *     install a dependency, and cannot call a provider on the organization's behalf.
 *   - **Memory, CPU, and process limits.** A subprocess can exhaust the host; a
 *     container is bounded.
 *   - **A read-only root with a small writable tmpfs**, so code cannot persist
 *     anything beyond its own run.
 *   - **A non-root user and dropped capabilities.**
 *
 * What it still does not provide: kernel isolation. A container escape reaches the
 * host. For a public run with genuinely untrusted operators, a microVM is the right
 * answer, and `isolation` says so rather than implying this is the end of the story.
 *
 * Spec: §31, §6.10.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_LIMITS,
  type Sandbox,
  type SandboxLimits,
  type SandboxRequest,
  type SandboxResult,
} from "./sandbox.js";

export interface ContainerSandboxOptions {
  /** Container runtime binary. `docker` or `podman`. */
  readonly runtime?: string;
  /**
   * Image to execute in.
   *
   * Must be pinned by digest for a confirmatory run: a floating tag means the
   * execution environment can change under the study, which is the same drift the
   * research protocol pins model snapshots to avoid.
   */
  readonly image?: string;
  readonly memoryMb?: number;
  readonly cpus?: string;
  readonly maxProcesses?: number;
  /** Injectable, so availability detection is testable. */
  readonly spawnImpl?: typeof spawn;
}

const DEFAULT_IMAGE = "node:22-alpine";

export class ContainerSandbox implements Sandbox {
  readonly id: string;
  readonly isolation: string;

  readonly #runtime: string;
  readonly #image: string;
  readonly #memoryMb: number;
  readonly #cpus: string;
  readonly #maxProcesses: number;
  readonly #spawn: typeof spawn;

  constructor(options: ContainerSandboxOptions = {}) {
    this.#runtime = options.runtime ?? "docker";
    this.#image = options.image ?? DEFAULT_IMAGE;
    this.#memoryMb = options.memoryMb ?? 256;
    this.#cpus = options.cpus ?? "1.0";
    this.#maxProcesses = options.maxProcesses ?? 128;
    this.#spawn = options.spawnImpl ?? spawn;

    this.id = `container-${this.#runtime}-v1`;
    this.isolation =
      `container-level via ${this.#runtime} (${this.#image}): separate namespaces, ` +
      `--network=none, read-only root with a writable tmpfs, ${this.#memoryMb}MB memory, ` +
      `${this.#cpus} CPU, ${this.#maxProcesses} process limit, non-root user, all ` +
      `capabilities dropped. Shares the host kernel: a container escape reaches the ` +
      `host, so a microVM is required for genuinely untrusted operators (§31).`;
  }

  /**
   * Whether the runtime is usable.
   *
   * Checked explicitly rather than discovered by a confusing failure mid-run. A
   * scenario that requires container isolation should refuse to start without it, not
   * quietly fall back to something weaker.
   */
  async available(): Promise<boolean> {
    return new Promise((resolvePromise) => {
      const child = this.#spawn(this.#runtime, ["version", "--format", "{{.Server.Version}}"], {
        stdio: "ignore",
      });
      child.on("error", () => resolvePromise(false));
      child.on("close", (code) => resolvePromise(code === 0));
    });
  }

  async run(request: SandboxRequest): Promise<SandboxResult> {
    const limits = request.limits ?? DEFAULT_LIMITS;
    const rejection = validate(request, limits);
    if (rejection !== undefined) {
      return {
        outcome: "rejected",
        exitCode: undefined,
        stdout: "",
        stderr: "",
        durationMs: 0,
        rejection,
      };
    }

    const root = await mkdtemp(join(tmpdir(), "freeq-container-"));
    const started = Date.now();

    try {
      for (const [path, content] of request.files) {
        const target = join(root, path);
        if (!resolve(target).startsWith(resolve(root))) {
          return {
            outcome: "rejected",
            exitCode: undefined,
            stdout: "",
            stderr: "",
            durationMs: Date.now() - started,
            rejection: `path ${JSON.stringify(path)} escapes the sandbox root`,
          };
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }

      return await this.#execute(root, request, limits, started);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  #containerArgs(root: string, entryPoint: string, limits: SandboxLimits): string[] {
    return [
      "run",
      "--rm",
      // The single most valuable control: code that cannot reach the network cannot
      // exfiltrate a secret, install a dependency, or call a provider (§6.10).
      "--network=none",
      "--read-only",
      // A small writable tmpfs, so code can use /tmp without persisting anything.
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      `--memory=${this.#memoryMb}m`,
      // Without this, memory pressure spills to swap instead of failing.
      `--memory-swap=${this.#memoryMb}m`,
      `--cpus=${this.#cpus}`,
      `--pids-limit=${this.#maxProcesses}`,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      // Non-root, so a container escape starts unprivileged.
      "--user=1000:1000",
      // The workspace is mounted read-only: the tree under test must not be modifiable
      // by the code under test, or a criterion could rewrite the module it is checking.
      "-v",
      `${root}:/work:ro`,
      "-w",
      "/work",
      // Belt and braces with the outer timeout: the runtime kills it even if the
      // parent process dies first.
      "--stop-timeout=1",
      this.#image,
      "node",
      entryPoint,
    ];
  }

  #execute(
    root: string,
    request: SandboxRequest,
    limits: SandboxLimits,
    started: number,
  ): Promise<SandboxResult> {
    return new Promise((resolvePromise) => {
      const child = this.#spawn(
        this.#runtime,
        this.#containerArgs(root, request.entryPoint, limits),
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let settled = false;

      const finish = (result: Omit<SandboxResult, "durationMs">): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ ...result, durationMs: Date.now() - started });
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ outcome: "timed_out", exitCode: undefined, stdout, stderr });
      }, limits.timeoutMs);

      const capture = (chunk: Buffer, isError: boolean): void => {
        bytes += chunk.byteLength;
        if (bytes > limits.maxOutputBytes) {
          child.kill("SIGKILL");
          finish({ outcome: "output_limit_exceeded", exitCode: undefined, stdout, stderr });
          return;
        }
        if (isError) stderr += chunk.toString("utf8");
        else stdout += chunk.toString("utf8");
      };

      child.stdout?.on("data", (chunk: Buffer) => capture(chunk, false));
      child.stderr?.on("data", (chunk: Buffer) => capture(chunk, true));

      child.on("error", (error) => {
        finish({
          outcome: "failed",
          exitCode: undefined,
          stdout,
          stderr: `${stderr}\n${this.#runtime} could not be started: ${String(error)}`,
        });
      });

      child.on("close", (code) => {
        finish({
          outcome: code === 0 ? "succeeded" : "failed",
          exitCode: code ?? undefined,
          stdout,
          stderr,
        });
      });
    });
  }
}

function validate(request: SandboxRequest, limits: SandboxLimits): string | undefined {
  if (request.files.size === 0) return "no files to execute";
  if (request.files.size > limits.maxFiles) {
    return `${request.files.size} files exceeds the limit of ${limits.maxFiles}`;
  }
  if (!request.files.has(request.entryPoint)) {
    return `entry point ${request.entryPoint} is not among the supplied files`;
  }
  for (const [path, content] of request.files) {
    const size = Buffer.byteLength(content, "utf8");
    if (size > limits.maxFileBytes) {
      return `${path} is ${size} bytes, over the ${limits.maxFileBytes} limit`;
    }
  }
  return undefined;
}

/**
 * Pick the strongest available sandbox.
 *
 * Prefers containers and says clearly when it has fallen back. A silent downgrade
 * would let a run believe it had isolation it does not have, and a sandbox believed to
 * be stronger than it is, is worse than no sandbox.
 */
export async function bestAvailableSandbox(
  options: ContainerSandboxOptions & { readonly requireContainer?: boolean } = {},
): Promise<{ readonly sandbox: Sandbox; readonly note: string }> {
  const container = new ContainerSandbox(options);
  if (await container.available()) {
    return { sandbox: container, note: `container isolation via ${container.id}` };
  }
  if (options.requireContainer === true) {
    throw new Error(
      `${options.runtime ?? "docker"} is unavailable and container isolation was required. ` +
        `Refusing to fall back: a run that needs isolation should not proceed without it.`,
    );
  }
  const { NodeSubprocessSandbox } = await import("./sandbox.js");
  return {
    sandbox: new NodeSubprocessSandbox(),
    note:
      "FELL BACK to process-level isolation: no container runtime is available. " +
      "Adequate for code the controller supplies; NOT sufficient for untrusted code " +
      "from external operators (§31).",
  };
}
