/**
 * Evaluation and the narrowing checker.
 *
 * Evaluation is total and pure: no loops, no I/O, no clock, no randomness.
 * Deterministic given `(expression, context)`, which is what replay requires.
 *
 * Denial is the default. An expression that fails to parse, references an unknown
 * attribute, or errors *denies* — there is no fail-open path. An unknown attribute
 * denies rather than evaluating false, because silently treating a typo as
 * "condition not met" would make a rule quietly permissive in a way nobody would
 * notice.
 *
 * Spec: §20.4, §20.5, §20.7. Decision: ADR-0010.
 */
import {
  POLICY_LANGUAGE,
  PolicyParseError,
  parsePolicy,
  type Comparison,
  type Expression,
  type Literal,
  type Operator,
} from "./parse.js";

/** Engine version, recorded on every decision so replay reproduces it (§32.6). */
export const POLICY_ENGINE_VERSION = 1;

export type AttributeValue = string | number | boolean;

/** Attributes available to an expression. A fixed vocabulary, by design. */
export type PolicyContext = Readonly<Record<string, AttributeValue>>;

export interface Decision {
  readonly allowed: boolean;
  /** Human-readable trace. §20.4 requires a denial to be explicable. */
  readonly reason: string;
  readonly engine: string;
  readonly engineVersion: number;
  /** Comparison that decided a denial, when one did. */
  readonly failedComparison?: string;
}

function deny(reason: string, failedComparison?: string): Decision {
  return {
    allowed: false,
    reason,
    engine: POLICY_LANGUAGE,
    engineVersion: POLICY_ENGINE_VERSION,
    ...(failedComparison === undefined ? {} : { failedComparison }),
  };
}

function allow(reason: string): Decision {
  return {
    allowed: true,
    reason,
    engine: POLICY_LANGUAGE,
    engineVersion: POLICY_ENGINE_VERSION,
  };
}

/** Evaluate expression source against a context. Never throws. */
export function evaluatePolicy(source: string, context: PolicyContext): Decision {
  let expression: Expression;
  try {
    expression = parsePolicy(source);
  } catch (error) {
    return deny(
      error instanceof PolicyParseError
        ? `expression does not parse: ${error.message}`
        : `expression could not be read: ${String(error)}`,
    );
  }
  return evaluateExpression(expression, context);
}

export function evaluateExpression(
  expression: Expression,
  context: PolicyContext,
): Decision {
  for (const comparison of expression.comparisons) {
    const rendered = renderComparison(comparison);

    if (!(comparison.attribute in context)) {
      // Not `false`: an unknown attribute means the rule cannot be evaluated, and
      // a rule that cannot be evaluated must not permit anything.
      return deny(
        `attribute ${comparison.attribute} is not in the evaluation context, so the rule cannot be decided`,
        rendered,
      );
    }

    const actual = context[comparison.attribute] as AttributeValue;
    const outcome = compare(actual, comparison);

    if (outcome === undefined) {
      return deny(
        `cannot apply '${comparison.operator}' to ${typeof actual} value of ${comparison.attribute}`,
        rendered,
      );
    }
    if (!outcome) {
      return deny(
        `${comparison.attribute} is ${JSON.stringify(actual)}, which fails ${rendered}`,
        rendered,
      );
    }
  }

  return allow(
    expression.comparisons.length === 0
      ? "no conditions"
      : `all ${expression.comparisons.length} condition(s) satisfied`,
  );
}

/** Returns undefined when the operator does not apply to the value's type. */
function compare(actual: AttributeValue, comparison: Comparison): boolean | undefined {
  const { operator, value } = comparison;

  switch (operator) {
    case "=":
      return actual === value;
    case "!=":
      return actual !== value;
    case "<":
    case "<=":
    case ">":
    case ">=": {
      if (typeof actual !== "number" || typeof value !== "number") return undefined;
      if (operator === "<") return actual < value;
      if (operator === "<=") return actual <= value;
      if (operator === ">") return actual > value;
      return actual >= value;
    }
    case "in":
      if (!Array.isArray(value)) return undefined;
      return (value as readonly (string | number)[]).includes(
        actual as string | number,
      );
    case "glob":
      if (typeof actual !== "string" || typeof value !== "string") return undefined;
      return globMatches(value, actual);
    default:
      return undefined;
  }
}

function renderComparison(comparison: Comparison): string {
  const value = Array.isArray(comparison.value)
    ? `[${comparison.value.join(", ")}]`
    : JSON.stringify(comparison.value);
  return `${comparison.attribute} ${comparison.operator} ${value}`;
}

// ---------------------------------------------------------------------------
// Glob
// ---------------------------------------------------------------------------

/**
 * Match a restricted glob: `*` within a path segment, `**` across segments, `?`
 * for one character.
 *
 * Restricted deliberately. A fuller glob syntax — character classes, brace
 * alternation — would reintroduce disjunction through the back door and take
 * pattern containment with it.
 */
export function globMatches(pattern: string, value: string): boolean {
  return new RegExp(`^${globToRegexSource(pattern)}$`).test(value);
}

function globToRegexSource(pattern: string): string {
  let source = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i] as string;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i += 2;
        // Absorb a following slash so `a/**/b` matches `a/b`.
        if (pattern[i] === "/") i++;
        continue;
      }
      source += "[^/]*";
      i++;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      i++;
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  return source;
}

/**
 * Is every string matched by `child` also matched by `parent`?
 *
 * Conservative: returns false whenever containment cannot be established.
 * Refusing a legitimate narrowing is an inconvenience; permitting an illegitimate
 * one is a privilege escalation.
 */
export function globNarrows(child: string, parent: string): boolean {
  if (child === parent) return true;
  // A parent that matches everything contains anything.
  if (parent === "**" || parent === "*") {
    return parent === "**" || !child.includes("/");
  }

  const childSegments = child.split("/");
  const parentSegments = parent.split("/");

  let ci = 0;
  let pi = 0;
  while (pi < parentSegments.length) {
    const parentSegment = parentSegments[pi] as string;

    if (parentSegment === "**") {
      // Trailing `**` absorbs the rest.
      if (pi === parentSegments.length - 1) return true;
      // A `**` in the middle needs alignment analysis we do not attempt; refuse
      // rather than approximate.
      return false;
    }

    const childSegment = childSegments[ci];
    if (childSegment === undefined) return false;
    if (childSegment === "**") return false; // child is broader
    if (!segmentNarrows(childSegment, parentSegment)) return false;

    ci++;
    pi++;
  }

  return ci === childSegments.length;
}

function segmentNarrows(child: string, parent: string): boolean {
  if (child === parent) return true;
  if (parent === "*") return !child.includes("**");
  if (child === "*") return false; // child is broader than a literal parent
  // Both contain wildcards, or the child is literal and the parent is a pattern.
  if (!child.includes("*") && !child.includes("?")) return globMatches(parent, child);
  // Pattern-in-pattern beyond the cases above: refuse.
  return false;
}

// ---------------------------------------------------------------------------
// Narrowing (attenuation, §20.5)
// ---------------------------------------------------------------------------

export interface NarrowingResult {
  readonly narrows: boolean;
  readonly reason: string;
}

/**
 * Is `child` strictly no broader than `parent`?
 *
 * This is the question ADR-0007 named as the discriminator, and the reason the
 * language forbids disjunction. Conjunction-only makes every case a direct
 * comparison instead of a satisfiability problem.
 *
 * Conservative throughout: unestablished containment is refused.
 */
export function narrows(childSource: string, parentSource: string): NarrowingResult {
  let child: Expression;
  let parent: Expression;
  try {
    child = parsePolicy(childSource);
    parent = parsePolicy(parentSource);
  } catch (error) {
    return {
      narrows: false,
      reason: `cannot compare unparseable expressions: ${String(error)}`,
    };
  }
  return expressionNarrows(child, parent);
}

export function expressionNarrows(
  child: Expression,
  parent: Expression,
): NarrowingResult {
  // Every parent constraint must be satisfied by some child constraint. Extra
  // child constraints only narrow further, so they need no justification.
  for (const parentComparison of parent.comparisons) {
    const relevant = child.comparisons.filter(
      (c) => c.attribute === parentComparison.attribute,
    );
    if (relevant.length === 0) {
      return {
        narrows: false,
        reason:
          `child does not constrain ${parentComparison.attribute}, which the parent ` +
          `restricts with ${renderComparison(parentComparison)}`,
      };
    }
    if (!relevant.some((c) => comparisonNarrows(c, parentComparison))) {
      return {
        narrows: false,
        reason:
          `child's constraint on ${parentComparison.attribute} is not contained in ` +
          `the parent's ${renderComparison(parentComparison)}`,
      };
    }
  }

  return {
    narrows: true,
    reason:
      parent.comparisons.length === 0
        ? "parent is unconstrained, so any child narrows it"
        : `all ${parent.comparisons.length} parent constraint(s) are narrowed`,
  };
}

function comparisonNarrows(child: Comparison, parent: Comparison): boolean {
  if (child.attribute !== parent.attribute) return false;

  // Equality is the narrowest form: it narrows any parent constraint it satisfies.
  if (child.operator === "=") {
    const outcome = compare(child.value as AttributeValue, parent);
    return outcome === true;
  }

  if (child.operator !== parent.operator) {
    // Cross-operator containment beyond the equality case above needs reasoning
    // we deliberately do not attempt.
    return false;
  }

  switch (parent.operator) {
    case "<":
    case "<=":
      return numeric(child.value) <= numeric(parent.value);
    case ">":
    case ">=":
      return numeric(child.value) >= numeric(parent.value);
    case "!=":
      return child.value === parent.value;
    case "in": {
      if (!Array.isArray(child.value) || !Array.isArray(parent.value)) return false;
      const allowed = new Set(parent.value as readonly (string | number)[]);
      return (child.value as readonly (string | number)[]).every((v) =>
        allowed.has(v),
      );
    }
    case "glob":
      return globNarrows(String(child.value), String(parent.value));
    default:
      return false;
  }
}

function numeric(value: Literal): number {
  return typeof value === "number" ? value : Number.NaN;
}

/** Attribute names an expression reads, for vocabulary validation. */
export function attributesOf(source: string): readonly string[] {
  try {
    return [...new Set(parsePolicy(source).comparisons.map((c) => c.attribute))];
  } catch {
    return [];
  }
}

/**
 * Check an expression against the permitted vocabulary.
 *
 * Agents cannot invent attributes (ADR-0010). Rejecting at proposal time gives a
 * clear error, instead of a rule that parses and then denies everything forever.
 */
export function validateAttributes(
  source: string,
  vocabulary: readonly string[],
): readonly string[] {
  const allowed = new Set(vocabulary);
  return attributesOf(source).filter((attribute) => !allowed.has(attribute));
}

export type { Operator };
