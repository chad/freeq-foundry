/**
 * Sandboxed execution.
 *
 * §59.7: "Assume generated code is dangerous." Enforces the §6.10 safety invariant
 * — agents must never reach the operator's credentials, filesystem, private
 * network, or unrelated infrastructure.
 *
 * ## What this actually provides, and what it does not
 *
 * `NodeSubprocessSandbox` gives **process-level** isolation: a fresh child process,
 * a scrubbed environment, a temporary directory outside the repository, a wall-clock
 * timeout, an output cap, and no inherited stdio. That is a real boundary and it is
 * enough for a controlled run whose code the controller supplies.
 *
 * It is **not** sufficient for untrusted code from strangers. A child process shares
 * the kernel, the filesystem outside its cwd, and the network stack. §31 requires
 * containers or microVMs and ADR-0002 notes Node cannot provide in-process
 * isolation. Before Milestone 11 admits external operators, a container-backed
 * runner must implement this same interface.
 *
 * Saying so plainly matters more than the code here. A sandbox that is believed to
 * be stronger than it is, is worse than no sandbox.
 *
 * Spec: §31, §6.10.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SandboxLimits {
  /** Wall-clock ceiling. A run that will not stop must be stopped. */
  readonly timeoutMs: number;
  /** Combined stdout+stderr cap, to bound a process that floods output. */
  readonly maxOutputBytes: number;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: 10_000,
  maxOutputBytes: 256 * 1024,
  maxFileBytes: 512 * 1024,
  maxFiles: 200,
};

export type SandboxOutcome =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "output_limit_exceeded"
  | "rejected";

export interface SandboxResult {
  readonly outcome: SandboxOutcome;
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** Why a request was refused before execution. */
  readonly rejection?: string;
}

export interface SandboxRequest {
  /** Files to materialize, relative to the sandbox root. */
  readonly files: ReadonlyMap<string, string>;
  /** Entry point, relative to the sandbox root. */
  readonly entryPoint: string;
  readonly limits?: SandboxLimits;
  /**
   * Isolation profile.
   *
   * `strict` scrubs the environment entirely. `inherit_node` additionally passes
   * `PATH`, which is needed to find the interpreter on some systems and is a real
   * widening — hence the explicit opt-in.
   */
  readonly profile?: "strict" | "inherit_node";
}

export interface Sandbox {
  readonly id: string;
  /** Honest description of the isolation this implementation provides. */
  readonly isolation: string;
  run(request: SandboxRequest): Promise<SandboxResult>;
}

/**
 * Environment variables a sandboxed process may see.
 *
 * Nothing by default. Every real secret leak in a system like this starts with an
 * inherited environment, and the operator's shell holds credentials for services
 * that have nothing to do with the run (§6.10).
 */
function sandboxEnv(profile: "strict" | "inherit_node"): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    // A stable, minimal environment so a run is reproducible.
    NODE_ENV: "sandbox",
    HOME: "/nonexistent",
    TZ: "UTC",
    // Signals to code that it is sandboxed, so a test can assert on it.
    FREEQ_SANDBOX: "1",
  };
  if (profile === "inherit_node") {
    base["PATH"] = process.env["PATH"] ?? "";
  }
  return base;
}

export class NodeSubprocessSandbox implements Sandbox {
  readonly id = "node-subprocess-v1";
  readonly isolation =
    "process-level: fresh child process, scrubbed environment, temporary cwd, " +
    "wall-clock timeout, output cap. Shares the kernel, filesystem outside cwd, " +
    "and network stack. NOT sufficient for untrusted external code (§31).";

  async run(request: SandboxRequest): Promise<SandboxResult> {
    const limits = request.limits ?? DEFAULT_LIMITS;
    const rejection = validateRequest(request, limits);
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

    // Outside the repository, so a path traversal that slipped through cannot
    // reach project files.
    const root = await mkdtemp(join(tmpdir(), "freeq-sandbox-"));
    const started = Date.now();

    try {
      for (const [path, content] of request.files) {
        const target = join(root, path);
        // Belt and braces: the repository already refuses unsafe paths, but a
        // sandbox that trusts its input is not a sandbox.
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
      // Teardown always, including on throw. A sandbox that leaks directories is
      // a sandbox that eventually fills a disk mid-run.
      await rm(root, { recursive: true, force: true });
    }
  }

  #execute(
    root: string,
    request: SandboxRequest,
    limits: SandboxLimits,
    started: number,
  ): Promise<SandboxResult> {
    return new Promise((resolvePromise) => {
      const child = spawn(process.execPath, [request.entryPoint], {
        cwd: root,
        env: sandboxEnv(request.profile ?? "strict"),
        stdio: ["ignore", "pipe", "pipe"],
      });

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
        finish({
          outcome: "timed_out",
          exitCode: undefined,
          stdout,
          stderr,
        });
      }, limits.timeoutMs);

      const capture = (chunk: Buffer, isError: boolean): void => {
        bytes += chunk.byteLength;
        if (bytes > limits.maxOutputBytes) {
          child.kill("SIGKILL");
          finish({
            outcome: "output_limit_exceeded",
            exitCode: undefined,
            stdout,
            stderr,
          });
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
          stderr: `${stderr}\n${String(error)}`,
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

function validateRequest(
  request: SandboxRequest,
  limits: SandboxLimits,
): string | undefined {
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
 * Scan for secrets before anything is stored or executed.
 *
 * §31 requires secret scanning. Deliberately crude and deliberately noisy: a false
 * positive costs a developer a minute, and a false negative costs a credential.
 */
export function scanForSecrets(
  files: ReadonlyMap<string, string>,
): readonly { readonly path: string; readonly pattern: string }[] {
  const patterns: readonly { readonly name: string; readonly regex: RegExp }[] = [
    { name: "private key block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: "aws access key id", regex: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: "github token", regex: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
    { name: "slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
    { name: "generic api key assignment", regex: /(?:api[_-]?key|secret|password)\s*[:=]\s*['"][^'"]{12,}['"]/i },
    { name: "bearer token", regex: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/ },
  ];

  const findings: { path: string; pattern: string }[] = [];
  for (const [path, content] of files) {
    for (const { name, regex } of patterns) {
      if (regex.test(content)) findings.push({ path, pattern: name });
    }
  }
  return findings;
}
