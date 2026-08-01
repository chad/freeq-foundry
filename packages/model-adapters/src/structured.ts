/**
 * Structured response parsing.
 *
 * §24.5 requires a structured response; §47.1 requires malformed output to be
 * handled rather than crashing the run. Models emit prose, fenced code blocks,
 * trailing commentary, and occasionally valid JSON. All of it must resolve to either
 * a parsed action list or a definite, recorded failure.
 *
 * Recovery is deliberately bounded. Aggressive repair — inferring intent from
 * malformed output — would let the harness invent actions the model did not request,
 * and an action nobody asked for is worse than a wasted activation.
 *
 * Spec: §24.5, §24.6, §47.1.
 */

export type ParseOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly recovered: boolean; readonly note?: string }
  | { readonly ok: false; readonly reason: string; readonly excerpt: string };

/**
 * Extract a JSON object or array from model output.
 *
 * Tries, in order: the whole text, a fenced block, then the first balanced
 * brace-or-bracket span. Stops there. Anything requiring more guessing than this is
 * reported as malformed, because the alternative is fabricating intent.
 */
export function extractJson(text: string): ParseOutcome<unknown> {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: false, reason: "response was empty", excerpt: "" };
  }

  const direct = tryParse(trimmed);
  if (direct !== undefined) return { ok: true, value: direct, recovered: false };

  // Fenced block, with or without a language tag.
  const fence = /```(?:json|jsonc|javascript)?\s*\n?([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1] !== undefined) {
    const fenced = tryParse(fence[1].trim());
    if (fenced !== undefined) {
      return {
        ok: true,
        value: fenced,
        recovered: true,
        note: "extracted from a fenced code block",
      };
    }
  }

  const balanced = firstBalancedSpan(trimmed);
  if (balanced !== undefined) {
    const parsed = tryParse(balanced);
    if (parsed !== undefined) {
      return {
        ok: true,
        value: parsed,
        recovered: true,
        note: "extracted a balanced JSON span from surrounding prose",
      };
    }
  }

  return {
    ok: false,
    reason: "no parseable JSON object or array in the response",
    excerpt: excerpt(trimmed),
  };
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * First balanced `{…}` or `[…]` span, respecting string literals.
 *
 * String-aware because a brace inside a string is not structure, and a naive scan
 * truncates any payload containing code — which is most of them, in this system.
 */
function firstBalancedSpan(text: string): string | undefined {
  for (let start = 0; start < text.length; start++) {
    const opener = text[start];
    if (opener !== "{" && opener !== "[") continue;
    const closer = opener === "{" ? "}" : "]";

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
      const char = text[i] as string;

      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === opener) depth++;
      else if (char === closer) {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

const MAX_EXCERPT = 400;

function excerpt(text: string): string {
  return text.length <= MAX_EXCERPT ? text : `${text.slice(0, MAX_EXCERPT)}…`;
}

/**
 * The response shape agents must produce.
 *
 * `reasoning` is a short public rationale, not hidden chain-of-thought: §33.8 is
 * explicit that the platform should not require or expose hidden reasoning. It is
 * recorded because a governance record without stated reasons is much less useful,
 * and because §16.2 requires a proposal rationale anyway.
 */
export interface StructuredResponse {
  readonly reasoning: string;
  readonly actions: readonly Record<string, unknown>[];
}

/**
 * Parse and shape-check a structured response.
 *
 * Validates only the envelope. Whether an individual action is *permitted* is the
 * authorizer's question, and answering it here would put policy in two places.
 */
export function parseStructuredResponse(
  text: string,
  options: { readonly maxActions?: number } = {},
): ParseOutcome<StructuredResponse> {
  const maxActions = options.maxActions ?? 8;
  const extracted = extractJson(text);
  if (!extracted.ok) return extracted;

  const value = extracted.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      reason: "expected a JSON object with `reasoning` and `actions`",
      excerpt: excerpt(text),
    };
  }

  const record = value as Record<string, unknown>;
  const rawActions = record["actions"];
  if (!Array.isArray(rawActions)) {
    return {
      ok: false,
      reason: "`actions` must be an array",
      excerpt: excerpt(text),
    };
  }

  if (rawActions.length > maxActions) {
    // Truncated rather than refused: a model that proposes twelve actions has
    // usually proposed eight good ones. Recorded as recovery so the truncation is
    // visible.
    return {
      ok: true,
      value: {
        reasoning: asString(record["reasoning"]),
        actions: rawActions.slice(0, maxActions).filter(isActionObject),
      },
      recovered: true,
      note: `truncated ${rawActions.length} actions to ${maxActions}`,
    };
  }

  const actions = rawActions.filter(isActionObject);
  if (actions.length !== rawActions.length) {
    return {
      ok: false,
      reason: "every action must be an object with a string `type`",
      excerpt: excerpt(text),
    };
  }

  return {
    ok: true,
    value: { reasoning: asString(record["reasoning"]), actions },
    recovered: extracted.recovered,
    ...(extracted.note === undefined ? {} : { note: extracted.note }),
  };
}

function isActionObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)["type"] === "string"
  );
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A corrective message for a malformed response.
 *
 * §47.1 wants malformed output handled, and one precise retry is a better use of
 * budget than discarding the activation. Quotes the actual failure rather than
 * repeating the schema, because a model that produced prose already had the schema.
 */
export function repairPrompt(reason: string, excerptText: string): string {
  return [
    `Your previous response could not be parsed: ${reason}`,
    "",
    "It began:",
    "---",
    excerptText,
    "---",
    "",
    "Reply with a single JSON object and nothing else — no prose, no code fences:",
    '{"reasoning":"<one or two sentences>","actions":[{"type":"<action type>", ...}]}',
  ].join("\n");
}
