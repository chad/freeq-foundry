/**
 * Parser for `freeq-rules-v1`.
 *
 * A conjunction of comparisons over a fixed attribute vocabulary. No disjunction,
 * no negation, no arithmetic, no loops, no user-defined functions — the
 * restriction is what makes attenuation checking decidable (ADR-0010).
 *
 * Spec: §17.3, §20.5. Decision: ADR-0010.
 */

export const POLICY_LANGUAGE = "freeq-rules-v1";

export type Operator = "=" | "!=" | "<" | "<=" | ">" | ">=" | "glob" | "in";

export type Literal = string | number | readonly (string | number)[];

export interface Comparison {
  readonly attribute: string;
  readonly operator: Operator;
  readonly value: Literal;
}

/** A parsed expression: an implicit conjunction of comparisons. */
export interface Expression {
  readonly comparisons: readonly Comparison[];
}

export class PolicyParseError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(`${message} (at position ${position})`);
    this.name = "PolicyParseError";
    this.position = position;
  }
}

const OPERATORS: readonly Operator[] = ["!=", "<=", ">=", "=", "<", ">", "glob", "in"];

interface Token {
  readonly kind: "ident" | "operator" | "string" | "number" | "and" | "[" | "]" | ",";
  readonly text: string;
  readonly position: number;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i] as string;

    if (/\s/.test(char)) {
      i++;
      continue;
    }

    if (char === "[" || char === "]" || char === ",") {
      tokens.push({ kind: char, text: char, position: i });
      i++;
      continue;
    }

    if (char === '"') {
      let text = "";
      let j = i + 1;
      while (j < source.length && source[j] !== '"') {
        if (source[j] === "\\") {
          const escaped = source[j + 1];
          if (escaped === undefined) {
            throw new PolicyParseError("unterminated escape sequence", j);
          }
          text += escaped;
          j += 2;
          continue;
        }
        text += source[j];
        j++;
      }
      if (j >= source.length) {
        throw new PolicyParseError("unterminated string literal", i);
      }
      tokens.push({ kind: "string", text, position: i });
      i = j + 1;
      continue;
    }

    if (/[0-9-]/.test(char)) {
      let j = i;
      if (source[j] === "-") j++;
      const start = j;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j++;
      if (j === start) {
        throw new PolicyParseError("expected a digit after '-'", i);
      }
      // No decimal point: ADR-0004 forbids floats in canonical payloads, and a
      // policy comparing against one could not be canonicalized.
      if (source[j] === ".") {
        throw new PolicyParseError(
          "non-integer numbers are not permitted; use an integer or a string",
          j,
        );
      }
      tokens.push({ kind: "number", text: source.slice(i, j), position: i });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_.]/.test(source[j] as string)) j++;
      const text = source.slice(i, j);
      if (text === "and") {
        tokens.push({ kind: "and", text, position: i });
      } else if (text === "glob" || text === "in") {
        tokens.push({ kind: "operator", text, position: i });
      } else if (text === "or" || text === "not") {
        // Named explicitly rather than reported as an unknown identifier,
        // because the omission is deliberate and worth explaining once.
        throw new PolicyParseError(
          `'${text}' is not part of ${POLICY_LANGUAGE}: disjunction and negation are excluded because they make attenuation checking undecidable (ADR-0010)`,
          i,
        );
      } else {
        tokens.push({ kind: "ident", text, position: i });
      }
      i = j;
      continue;
    }

    const operator = OPERATORS.find((op) => source.startsWith(op, i));
    if (operator !== undefined) {
      tokens.push({ kind: "operator", text: operator, position: i });
      i += operator.length;
      continue;
    }

    throw new PolicyParseError(`unexpected character ${JSON.stringify(char)}`, i);
  }

  return tokens;
}

/** Parse an expression. Throws {@link PolicyParseError} on any malformed input. */
export function parsePolicy(source: string): Expression {
  const tokens = tokenize(source);
  if (tokens.length === 0) {
    // An empty expression could plausibly mean "always true" or "always false".
    // Refusing is safer than guessing, since guessing wrong in either direction
    // is a security bug.
    throw new PolicyParseError("expression is empty", 0);
  }

  const comparisons: Comparison[] = [];
  let i = 0;

  for (;;) {
    const attribute = tokens[i];
    if (attribute === undefined || attribute.kind !== "ident") {
      throw new PolicyParseError(
        `expected an attribute name, found ${describe(attribute)}`,
        attribute?.position ?? source.length,
      );
    }

    const operator = tokens[i + 1];
    if (operator === undefined || operator.kind !== "operator") {
      throw new PolicyParseError(
        `expected an operator after ${attribute.text}, found ${describe(operator)}`,
        operator?.position ?? source.length,
      );
    }

    const { value, next } = parseLiteral(tokens, i + 2, source.length);

    const op = operator.text as Operator;
    if (op === "in" && !Array.isArray(value)) {
      throw new PolicyParseError("'in' requires a list literal", operator.position);
    }
    if (op !== "in" && Array.isArray(value)) {
      throw new PolicyParseError(
        `'${op}' does not accept a list literal`,
        operator.position,
      );
    }
    if (op === "glob" && typeof value !== "string") {
      throw new PolicyParseError("'glob' requires a string pattern", operator.position);
    }

    comparisons.push({ attribute: attribute.text, operator: op, value });
    i = next;

    if (i >= tokens.length) break;
    if (tokens[i]?.kind !== "and") {
      throw new PolicyParseError(
        `expected 'and' between comparisons, found ${describe(tokens[i])}`,
        tokens[i]?.position ?? source.length,
      );
    }
    i++;
  }

  return { comparisons };
}

function parseLiteral(
  tokens: readonly Token[],
  start: number,
  end: number,
): { value: Literal; next: number } {
  const token = tokens[start];
  if (token === undefined) {
    throw new PolicyParseError("expected a literal value", end);
  }

  if (token.kind === "string") return { value: token.text, next: start + 1 };
  if (token.kind === "number") return { value: Number(token.text), next: start + 1 };

  if (token.kind === "[") {
    const items: (string | number)[] = [];
    let i = start + 1;
    if (tokens[i]?.kind === "]") return { value: items, next: i + 1 };

    for (;;) {
      const item = tokens[i];
      if (item === undefined) throw new PolicyParseError("unterminated list", end);
      if (item.kind === "string") items.push(item.text);
      else if (item.kind === "number") items.push(Number(item.text));
      else {
        throw new PolicyParseError(
          `list items must be strings or integers, found ${describe(item)}`,
          item.position,
        );
      }
      i++;
      const separator = tokens[i];
      if (separator?.kind === "]") return { value: items, next: i + 1 };
      if (separator?.kind !== ",") {
        throw new PolicyParseError(
          `expected ',' or ']' in list, found ${describe(separator)}`,
          separator?.position ?? end,
        );
      }
      i++;
    }
  }

  if (token.kind === "ident") {
    // Agents will reach for this, so the error explains the design rather than
    // reporting a syntax surprise. Comparing two attributes would mean comparing
    // two attribute-relative constraints during narrowing, which is exactly the
    // reasoning ADR-0010 excludes.
    throw new PolicyParseError(
      `attribute-to-attribute comparison is not supported in ${POLICY_LANGUAGE}: ` +
        `compare against a literal, or have the harness compute a derived attribute ` +
        `(ADR-0010)`,
      token.position,
    );
  }

  throw new PolicyParseError(
    `expected a literal value, found ${describe(token)}`,
    token.position,
  );
}

function describe(token: Token | undefined): string {
  if (token === undefined) return "end of input";
  return JSON.stringify(token.text);
}

/** Render a parsed expression back to source. Round-trips. */
export function formatPolicy(expression: Expression): string {
  return expression.comparisons
    .map((c) => `${c.attribute} ${c.operator} ${formatLiteral(c.value)}`)
    .join(" and ");
}

function formatLiteral(value: Literal): string {
  if (Array.isArray(value)) return `[${value.map(formatLiteral).join(", ")}]`;
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}
