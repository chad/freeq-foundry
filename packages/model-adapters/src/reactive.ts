/**
 * A reactive scripted adapter, for testing the model path without a model.
 *
 * `ScriptedAdapter` replies positionally, which cannot carry an organization through
 * a run: the right action depends on what has already happened. This one reads the
 * briefing and responds to it, so the whole model path — prompt construction,
 * structured parsing, action dispatch, authorization — is exercised end to end while
 * staying free and deterministic.
 *
 * It is **not** a model, and reports verification level 0 accordingly. Keeping that
 * honest matters: a fixture that claimed model verification could be mistaken for
 * evidence about model behaviour.
 */
import type { ModelAdapter, ModelRequest, ModelResponse, VerificationLevel } from "./types.js";

export interface ReactiveRule {
  readonly name: string;
  /** Inspect the rendered briefing. */
  readonly when: (briefing: string) => boolean;
  /** Produce the actions, given the briefing. */
  readonly then: (briefing: string) => readonly Record<string, unknown>[];
  /** Optional wrapping, to exercise fenced-block and prose recovery. */
  readonly wrap?: "plain" | "fenced" | "prose";
}

export class ReactiveScriptedAdapter implements ModelAdapter {
  readonly id: string;
  readonly provider = "reactive-scripted";
  readonly modelIdentifier: string;
  readonly snapshotIdentifier: string;
  readonly apiVersion = "reactive";
  readonly verificationLevel: VerificationLevel = 0;

  readonly #rules: readonly ReactiveRule[];

  constructor(options: { readonly id: string; readonly rules: readonly ReactiveRule[] }) {
    this.id = options.id;
    this.modelIdentifier = options.id;
    this.snapshotIdentifier = options.id;
    this.#rules = options.rules;
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    // The last user message is the briefing; earlier ones are the system prompt and,
    // on a repair retry, the previous exchange.
    const briefing =
      [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";

    for (const rule of this.#rules) {
      if (!rule.when(briefing)) continue;
      const body = JSON.stringify({
        reasoning: rule.name,
        actions: rule.then(briefing),
      });
      return {
        ok: true,
        text: wrapBody(body, rule.wrap ?? "plain"),
        usage: { inputTokens: Math.ceil(briefing.length / 4), outputTokens: Math.ceil(body.length / 4) },
        latencyMs: 0,
      };
    }

    return {
      ok: true,
      text: JSON.stringify({ reasoning: "nothing to do", actions: [{ type: "noop" }] }),
      usage: { inputTokens: Math.ceil(briefing.length / 4), outputTokens: 20 },
      latencyMs: 0,
    };
  }
}

function wrapBody(body: string, wrap: "plain" | "fenced" | "prose"): string {
  if (wrap === "fenced") return `Here is my decision:\n\`\`\`json\n${body}\n\`\`\``;
  if (wrap === "prose") return `I have considered the state of the run. ${body} Let me know.`;
  return body;
}

/** Extract the agent's own DID from a briefing. */
export function selfDidFrom(briefing: string): string {
  return /^You are (did:key:[A-Za-z0-9]+)\./m.exec(briefing)?.[1] ?? "";
}

/** Extract every listed proposal id the agent has not voted on. */
export function unvotedProposalsFrom(briefing: string): readonly string[] {
  return [...briefing.matchAll(/^ {2}(p-\d+) .*YOU HAVE NOT VOTED/gm)].map(
    (match) => match[1] as string,
  );
}

/** Extract proposal ids whose deadline has passed, given the current logical time. */
export function dueProposalsFrom(briefing: string): readonly string[] {
  const now = Number(/^Logical time (\d+)\./m.exec(briefing)?.[1] ?? "0");
  return [...briefing.matchAll(/^ {2}(p-\d+) .*closes at logical time (\d+)/gm)]
    .filter((match) => Number(match[2]) <= now)
    .map((match) => match[1] as string);
}

export function unclaimedWorkFrom(
  briefing: string,
): readonly { readonly workItemId: string; readonly path: string; readonly description: string }[] {
  return [...briefing.matchAll(/^ {2}(\S+) \(unclaimed\) — (.*?) → write (\S+)$/gm)].map(
    (match) => ({
      workItemId: match[1] as string,
      description: match[2] as string,
      path: match[3] as string,
    }),
  );
}

export function listAfter(briefing: string, prefix: string): readonly string[] {
  const line = briefing.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) return [];
  return line
    .slice(prefix.length)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

export function reviewablePullRequestsFrom(briefing: string): readonly string[] {
  return [...briefing.matchAll(/^ {2}(pr-\d+) ".*" by did:key:/gm)].map(
    (match) => match[1] as string,
  );
}
