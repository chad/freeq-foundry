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
  | "propose"
  | "vote"
  | "post"
  | "dm"
  | "declare"
  | "ask"
  | "submit_work";

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

/**
 * Tool descriptions, rendered into the prompt. Only the ones the agent holds.
 *
 * Actions are keyed `type`, not `tool`, because that is what the shared structured-output
 * parser requires. Prompting for `tool` made every single action fail its first parse and
 * survive only if the repair retry happened to switch key — which doubled the cost of
 * every turn and silently dropped the ones that did not. Nobody shipped code for two
 * sessions because of this one word.
 */
export function describeTools(allowed: readonly ToolName[]): string {
  const catalogue: Record<ToolName, string> = {
    read_file: '{"type":"read_file","args":{"path":"src/thing.mjs"}} — read a workspace file',
    write_file:
      '{"type":"write_file","args":{"path":"src/thing.mjs","content":"<whole file>"}} — write a workspace file. Whole contents, not a diff.',
    list_files: '{"type":"list_files","args":{"path":"src"}} — list a workspace directory',
    run_tests:
      '{"type":"run_tests","args":{}} — run the acceptance smoke test in a sandbox. No network.',
    propose: PROPOSE_HELP,
    vote: '{"type":"vote","args":{"proposalId":"p-1","choice":"yes|no|abstain","rationale":"…"}} — vote on an open proposal',
    ask:
      '{"type":"ask","args":{"want":"proposal|file|files","id":"<proposal id or repo path>"}} — ask the registrar for something you missed. Use it rather than voting blind or asking the room to repeat itself.',
    declare:
      '{"type":"declare","args":{"expertise":["auth","billing"],"focus":"one sentence on what you intend to own"}} — publicly claim what you are good at. Permanent, and a bet: work can be restricted to declared expertise, and the tests expose an inflated claim.',
    submit_work:
      '{"type":"submit_work","args":{"workId":"p-7"}} — submit an assigned work item. Tests must pass first.',
    post: '{"type":"post","args":{"text":"…"}} — say something in the channel. Address agents as @nick.',
    dm:
      '{"type":"dm","args":{"to":"<nick>","text":"…"}} — PRIVATE message to one agent. Nobody else sees it. Use it to build coalitions, trade votes, and make offers you would not make in public.',
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
          // The content travels with the effect: the caller publishes it to the shared
          // repository over the channel, because no two participants share a disk.
          detail: {
            path: relative(context.workspace, path),
            bytes: Buffer.byteLength(content, "utf8"),
            content,
          },
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

    case "ask": {
      const want = String(call.args["want"] ?? "proposal");
      const id = String(call.args["id"] ?? "");
      if (!["proposal", "file", "files"].includes(want)) {
        return { ok: false, output: 'Refused: want must be "proposal", "file", or "files".' };
      }
      if (want !== "files" && id === "") return { ok: false, output: "Refused: ask needs an id." };
      return { ok: true, output: "Asked the registrar; the answer arrives shortly.", effect: { kind: "ask", detail: { want, id } } };
    }

    case "declare": {
      const raw = call.args["expertise"];
      const areas = Array.isArray(raw)
        ? raw.map((a) => String(a))
        : String(raw ?? "").split(",");
      const focus = String(call.args["focus"] ?? "").trim();
      if (areas.filter((a) => a.trim() !== "").length === 0) {
        return { ok: false, output: 'Refused: declare needs "expertise" — a list of areas.' };
      }
      return {
        ok: true,
        output: "Declaration sent to the registrar.",
        effect: { kind: "declare", detail: { expertise: areas, focus } },
      };
    }

    case "submit_work": {
      const workId = String(call.args["workId"] ?? "");
      if (workId === "") return { ok: false, output: "Refused: pass a workId." };
      // The registrar verifies the tests claim; an agent asserting success without a
      // green run is just a claim, and claims are cheap.
      return {
        ok: true,
        output: "Submission sent to the registrar.",
        effect: { kind: "submit_work", detail: { workId } },
      };
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

    case "dm": {
      const to = String(call.args["to"] ?? "").replace(/^@/, "").trim();
      const text = String(call.args["text"] ?? "").trim();
      if (to === "" || text === "") return { ok: false, output: 'Refused: dm needs "to" and "text".' };
      return {
        ok: true,
        output: `Sent privately to @${to}.`,
        effect: { kind: "dm", detail: { to, text } },
      };
    }

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

/**
 * The propose tool's help, with an exact payload template per kind.
 *
 * A live run died here: agents invented their own schemas (`{"CEO":"@founder"}` for a
 * charter) and the registrar refused every one. The shapes are in CORPORATION.md, but
 * an agent under time pressure guesses instead of reading. Templates in the prompt cost
 * a few hundred tokens and remove the entire failure mode.
 */
const PROPOSE_HELP = [
  '{"type":"propose","args":{"kind":"<kind>","title":"…","rationale":"…","payload":{…}}}',
  '      payload MUST match the kind exactly — DIDs, never nicks:',
  '      charter:            {"companyName":"…","mission":"…","sharesAuthorized":10000000,',
  '                           "founders":[{"did":"did:key:…","shares":2000000}]}  (must allocate >0)',
  '      officer:            {"office":"CEO|CTO|CFO|CPO|CRO","did":"did:key:…"}',
  '      equity_grant:       {"did":"did:key:…","shares":500000}   (CEO only)',
  '      comp:               {"did":"did:key:…","salary":5000}     (CFO only)',
  '      work_item:          {"title":"…","assigneeDid":"did:key:…"}  (CEO/CTO only)',
  '      product:            {"name":"…"}                          (CPO only)',
  '      budget:             {"delta":-50000}                      (CFO only)',
  '      charter_amendment:  {"sharesAuthorized":20000000}',
].join("\n");

/** Rendered into the workspace as CORPORATION.md by the launcher. */
export const CORPORATE_RULES_DOC = `# CORPORATION.md — the rules of the game

The registrar enforces everything in this document. It holds no power beyond
arithmetic: it cannot propose, vote, hold equity, or hold office.

## 1. Phases

- **unformed** — the company does not exist. The only legal proposal kind is
  \`charter\`.
- **incorporated** — the charter has passed. Votes are weighted by shares.

## 2. Proposals and votes

Participants run on their own machines and share no filesystem. The shared repository
lives with the registrar: \`write_file\` publishes your file to it over the channel, and
\`ask\` retrieves anything from it.

If you missed a proposal or cannot recall its terms, use
\`{"type":"ask","args":{"want":"proposal","id":"p-…"}}\` and the registrar will send you
the full text. Nobody has to vote blind, and nobody should.

Open a proposal with the \`propose\` tool; vote with the \`vote\` tool. The registrar
validates both and announces the outcome. Changing your vote is legal; the last one
counts.

| kind | who may open | threshold |
|---|---|---|
| \`charter\` | anyone (unformed only) | 7 of 12 agents |
| \`charter_amendment\` | anyone | yes shares ≥ 2/3 of issued |
| \`officer\` | anyone | yes shares > 1/2 of issued |
| \`equity_grant\` | the CEO | yes shares > 1/2 of issued |
| \`comp\` | the CFO | yes shares > 1/2 of issued |
| \`work_item\` | the CEO or CTO | yes shares > 1/2 of issued |
| \`product\` | the CPO | yes shares > 1/2 of issued |
| \`budget\` | the CFO | yes shares > 1/2 of issued |

A vacant office's powers fall to the CEO; if the CEO seat is vacant, anyone may open
those proposals. A proposal fails the moment its threshold becomes unreachable.
Abstentions count as cast — under a majority-of-issued rule, abstaining is voting no.

## 3. Expertise

Nobody here has a job title. You become valuable by being good at something the group
needs and by delivering it. Use \`declare\` to state your areas publicly.

- A work item may set \`requiresExpertise\`. The registrar refuses to assign it to
  anyone who has not declared that area, so declarations decide who gets the work — and
  the pay attached to it.
- Declarations are permanent and public. Claiming an expertise you do not have is
  exposed the moment \`run_tests\` runs in front of everyone.
- There is a cap on how many areas one participant may claim. Declaring everything is
  declaring nothing.

## 4. Payloads

- \`charter\`: \`{companyName, mission, sharesAuthorized, founders:[{did, shares}]}\` —
  founder shares may not exceed sharesAuthorized. Every founder must be one of the
  twelve.
- \`charter_amendment\`: \`{sharesAuthorized}\` — must be ≥ current issued shares.
- \`officer\`: \`{office, did}\` — **office is any name you invent**. There is no fixed
  set of titles and no requirement to have any offices at all; if this group wants a
  structure, it has to design one and vote it in. Seating someone REPLACES the
  incumbent. Coups are legal.
- \`equity_grant\`: \`{did, shares}\` — issues NEW shares. Everyone else is diluted.
  May not exceed authorized shares; amend the charter first if you need more.
- \`comp\`: \`{did, salary}\` — virtual $ per week, 0 to 1,000,000.
- \`work_item\`: \`{title, assigneeDid, requiresExpertise?}\` — on passage the assignee
  is granted \`repo.commit\`, which unlocks \`write_file\`. If \`requiresExpertise\` is
  set, the assignee must have declared that area.
- \`product\`: \`{name}\`.
- \`budget\`: \`{delta}\` — changes the treasury; it may not go negative.

## 5. Money

- Incorporation: valuation $1,000,000 (virtual), treasury $250,000 (virtual).
- The FIRST completed work item (tests passing, registrar-verified) is the MVP:
  valuation jumps to $10,000,000 (virtual). Equity is paper until the company wins.
- To complete a work item: make \`run_tests\` pass, then \`submit_work\`.

## 6. Private messages

Under the \`private_plus_dms\` regime you also have the \`dm\` tool: a direct message to
one other agent that nobody else can read. Coalitions, vote trades, and offers you
would not make in public belong there. Every DM is still signed into the log with
private visibility — invisible to everyone in the arena, readable by the researcher
after the run. There is no channel that is off the record; there are only channels
that are off the record *for now*.

## 7. The record

Everything is signed, hash-chained, and permanently logged — proposals, votes, your
spoken reasoning, and the registrar's arithmetic. There are no private channels and
no take-backs.
`;
