/**
 * Agent tools.
 *
 * §24.6 governs everything here: **model output is a proposal, not a fact.** A tool call
 * arrives as text the model produced, and is checked before it does anything.
 *
 * Two rules that are easy to get wrong and are enforced structurally instead of by
 * convention:
 *
 *   1. **A tool an agent does not hold does not exist for it.** Not "errors" — is absent
 *      from its prompt entirely. An agent told about a tool it cannot use will spend
 *      turns trying, and the transcript fills with refusals that teach a reader nothing.
 *   2. **Every filesystem tool is confined to the workspace.** Paths are
 *      participant-supplied, so `../../.ssh/id_rsa` is the first thing to try, and a
 *      workspace that resolves outside itself is a credential leak (§6.10).
 *
 * Test execution goes through the sandbox rather than running here, because agent code
 * is generated code (§59.7).
 */
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { Sandbox } from "@freeq-foundry/sandbox";

export type ToolName =
  | "read_file"
  | "write_file"
  | "list_files"
  | "run_tests"
  | "read_spec"
  | "propose"
  | "vote"
  | "post";

export interface ToolCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ToolResult {
  readonly ok: boolean;
  /** Fed back to the model. Kept short: a 10k-line dump crowds out the conversation. */
  readonly output: string;
  /** Set when the tool changed something, so the caller can record it as an event. */
  readonly effect?: { readonly kind: string; readonly detail: Record<string, unknown> };
}

export interface ToolContext {
  /** Absolute path the agent may touch. Nothing outside it is reachable. */
  readonly workspace: string;
  /** Read-only path to the specification, for `read_spec`. */
  readonly specPath: string;
  readonly sandbox: Sandbox;
  readonly allowed: readonly ToolName[];
  /** Namespaces governance has actually granted. Empty on arrival. */
  readonly granted: readonly string[];
}

const MAX_OUTPUT = 4000;
const MAX_WRITE_BYTES = 64 * 1024;

/**
 * Confine a path to the workspace.
 *
 * Returns null rather than throwing, so a traversal attempt is a normal refusal the
 * model can read and learn from rather than a crash.
 */
function confine(context: ToolContext, candidate: unknown): string | null {
  if (typeof candidate !== "string" || candidate === "" || candidate.includes("\0")) {
    return null;
  }
  const target = resolve(join(context.workspace, candidate));
  const root = resolve(context.workspace);
  // The trailing separator matters: `/work` must not accept `/workspace-elsewhere`.
  if (target !== root && !target.startsWith(`${root}/`)) return null;
  return target;
}

function truncate(text: string): string {
  return text.length <= MAX_OUTPUT
    ? text
    : `${text.slice(0, MAX_OUTPUT)}\n… truncated ${text.length - MAX_OUTPUT} bytes`;
}

/** Tool descriptions, rendered into the prompt. Only the ones the agent holds. */
export function describeTools(allowed: readonly ToolName[]): string {
  const catalogue: Record<ToolName, string> = {
    read_file: '{"tool":"read_file","args":{"path":"src/thing.mjs"}} — read a workspace file',
    write_file:
      '{"tool":"write_file","args":{"path":"src/thing.mjs","content":"<whole file>"}} — write a workspace file. Whole contents, not a diff.',
    list_files: '{"tool":"list_files","args":{"path":"src"}} — list a workspace directory',
    run_tests:
      '{"tool":"run_tests","args":{}} — run the acceptance smoke test in a sandbox. No network.',
    read_spec:
      '{"tool":"read_spec","args":{"section":"20.5"}} — read a numbered section of the specification',
    propose:
      '{"tool":"propose","args":{"title":"…","rationale":"…","namespace":"repo.commit","toDid":"<did or self>"}} — open a capability proposal',
    vote: '{"tool":"vote","args":{"proposalId":"p-1","choice":"yes","rationale":"…"}} — vote on an open proposal',
    post: '{"tool":"post","args":{"text":"…"}} — say something in the channel',
  };
  return allowed.map((tool) => `  ${catalogue[tool]}`).join("\n");
}

/**
 * Execute a tool call.
 *
 * Refuses a tool the agent does not hold even if the model asked for it — the prompt
 * omits it, so a request for one means the model invented it, and inventing capability
 * is exactly what must not silently work.
 */
export async function runTool(
  context: ToolContext,
  call: ToolCall,
): Promise<ToolResult> {
  const tool = call.tool as ToolName;

  if (!context.allowed.includes(tool)) {
    return {
      ok: false,
      output:
        `You do not have the tool "${call.tool}". Your tools are: ` +
        `${context.allowed.join(", ")}. Do not ask for others.`,
    };
  }

  switch (tool) {
    case "read_file": {
      const path = confine(context, call.args["path"]);
      if (path === null) {
        return { ok: false, output: "Refused: that path is outside your workspace." };
      }
      try {
        return { ok: true, output: truncate(await readFile(path, "utf8")) };
      } catch {
        return { ok: false, output: `No such file: ${String(call.args["path"])}` };
      }
    }

    case "list_files": {
      const path = confine(context, call.args["path"] ?? ".");
      if (path === null) {
        return { ok: false, output: "Refused: that path is outside your workspace." };
      }
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return {
          ok: true,
          output: entries
            .map((entry) => `${entry.isDirectory() ? "d" : "-"} ${entry.name}`)
            .sort()
            .join("\n"),
        };
      } catch {
        return { ok: false, output: `Not a directory: ${String(call.args["path"])}` };
      }
    }

    case "write_file": {
      const path = confine(context, call.args["path"]);
      const content = call.args["content"];
      if (path === null) {
        return { ok: false, output: "Refused: that path is outside your workspace." };
      }
      if (typeof content !== "string") {
        return { ok: false, output: "Refused: content must be a string." };
      }
      if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
        return { ok: false, output: `Refused: over ${MAX_WRITE_BYTES} bytes.` };
      }

      // Writing is a *repository* action, and §6.5 says holding the tool is not holding
      // the authority. The tool exists; the grant may not.
      if (!context.granted.some((ns) => "repo.commit".startsWith(ns))) {
        return {
          ok: false,
          output:
            "Refused: you hold the write_file tool but governance has not granted you " +
            "repo.commit. Propose the grant and get it passed first.",
        };
      }

      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      return {
        ok: true,
        output: `Wrote ${relative(context.workspace, path)} (${Buffer.byteLength(content, "utf8")} bytes).`,
        effect: {
          kind: "file_written",
          detail: { path: relative(context.workspace, path), bytes: Buffer.byteLength(content, "utf8") },
        },
      };
    }

    case "run_tests": {
      const files = await collectWorkspace(context.workspace);
      if (files.size === 0) {
        return { ok: false, output: "The workspace is empty; there is nothing to test." };
      }
      const result = await context.sandbox.run({
        files: new Map([...files, ["__smoke__.mjs", SMOKE_TEST]]),
        entryPoint: "__smoke__.mjs",
      });
      return {
        ok: result.outcome === "succeeded",
        output: truncate(
          `${result.outcome}\n${result.stdout}${result.stderr}`.trim() ||
            String(result.rejection ?? "no output"),
        ),
        effect: { kind: "tests_run", detail: { outcome: result.outcome } },
      };
    }

    case "read_spec": {
      const section = String(call.args["section"] ?? "").trim();
      if (section === "") {
        return { ok: false, output: 'Refused: pass a section, e.g. {"section":"20.5"}.' };
      }
      return { ok: true, output: truncate(await readSpecSection(context.specPath, section)) };
    }

    // Governance tools do not act here. They produce an effect the agent's own loop
    // turns into a signed Foundry event and a freeq coordination event, so the action
    // is recorded and visible rather than happening inside a tool call.
    case "propose":
      return {
        ok: true,
        output: "Proposal queued for the channel.",
        effect: { kind: "propose", detail: { ...call.args } },
      };

    case "vote":
      return {
        ok: true,
        output: "Vote queued for the channel.",
        effect: { kind: "vote", detail: { ...call.args } },
      };

    case "post":
      return {
        ok: true,
        output: "Posted.",
        effect: { kind: "post", detail: { text: String(call.args["text"] ?? "") } },
      };

    default:
      return { ok: false, output: `Unknown tool "${call.tool}".` };
  }
}

/** Every `.mjs` and `.md` under the workspace, for the sandbox. */
async function collectWorkspace(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(full);
        continue;
      }
      if (!/\.(mjs|js|json|md)$/.test(entry.name)) continue;
      const content = await readFile(full, "utf8");
      if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) continue;
      files.set(relative(root, full), content);
    }
  };

  await walk(root);
  return files;
}

/**
 * Read a numbered specification section.
 *
 * Stops at the next heading of the same or higher level, so a request for §20.5 returns
 * §20.5 rather than the rest of §20.
 */
async function readSpecSection(specPath: string, section: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(specPath, "utf8");
  } catch {
    return `The specification is not available at ${specPath}.`;
  }

  const lines = text.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^#{1,3} ${escape(section)}[. ]`).test(line));
  if (start === -1) return `No section ${section} in the specification.`;

  const level = (lines[start] as string).match(/^#+/)?.[0].length ?? 2;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const heading = (lines[i] as string).match(/^#+/)?.[0].length;
    if (heading !== undefined && heading <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The smoke test agents run.
 *
 * Deliberately weak — it asks whether the code loads, not whether it is correct.
 * Correctness is the evaluator's question, and a smoke test strong enough to answer it
 * would be doing the evaluator's job with tests the agents can read.
 */
const SMOKE_TEST = [
  'import { readdir } from "node:fs/promises";',
  'const entries = await readdir("src").catch(() => []);',
  'const modules = entries.filter((name) => name.endsWith(".mjs"));',
  "if (modules.length === 0) {",
  '  console.error("no modules under src/");',
  "  process.exit(1);",
  "}",
  "for (const name of modules) {",
  '  await import("./src/" + name).catch((error) => {',
  '    console.error(name + ": " + error.message);',
  "    process.exit(1);",
  "  });",
  "}",
  'console.log("loaded " + modules.length + " module(s): " + modules.join(", "));',
].join("\n");
