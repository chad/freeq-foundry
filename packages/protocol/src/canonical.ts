/**
 * Canonical serialization — RFC 8785 (JSON Canonicalization Scheme) plus the
 * restrictions in ADR-0004.
 *
 * Two independent implementations must produce byte-identical output for the
 * same logical value. If they do not, signatures and the hash chain are
 * worthless across languages, and the platform's central claim — that anyone
 * can bring an agent in any language — fails.
 *
 * Additions to plain JCS, each one closing a cross-implementation defect class:
 *
 *   1. Integers only. JCS number serialization is well defined for doubles but
 *      not intuitive across languages. Non-integer quantities are strings with
 *      a documented unit.
 *   2. Absent, not null. An optional field with no value is omitted; emitting
 *      null changes the bytes and therefore the hash.
 *   3. NFC normalization. Without it, visually identical strings hash
 *      differently.
 *   4. No lone surrogates.
 *   5. Depth and size limits.
 *
 * Spec: §33.5, §35.4, §51.1. Decision: ADR-0004.
 */
import { ProtocolError, ProtocolErrorCode } from "./errors.js";

/** Values that may appear in a canonicalizable structure. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | CanonicalValue[]
  | { [key: string]: CanonicalValue | undefined };

export interface CanonicalizeOptions {
  /** Maximum nesting depth. Default 64. */
  readonly maxDepth?: number;
  /** Maximum canonical size in bytes. Default 1 MiB. */
  readonly maxBytes?: number;
  /**
   * Allow explicit nulls. Off by default: ADR-0004 requires absent rather than
   * null. Enabled only where an external format forces null on us.
   */
  readonly allowNull?: boolean;
}

export const DEFAULT_MAX_DEPTH = 64;
export const DEFAULT_MAX_BYTES = 1024 * 1024;

const encoder = new TextEncoder();

/**
 * Serialize to canonical JSON text.
 *
 * Returns a string; use {@link canonicalizeToBytes} when hashing or signing.
 * The two differ only by UTF-8 encoding, which is total for well-formed input
 * because lone surrogates are rejected.
 */
export function canonicalize(
  value: CanonicalValue,
  options: CanonicalizeOptions = {},
): string {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const allowNull = options.allowNull ?? false;

  const out = serialize(value, 0, "", { maxDepth, allowNull });

  // Size is measured on encoded bytes, not UTF-16 code units. A string of
  // 1 MiB characters is not a string of 1 MiB bytes.
  const byteLength = encoder.encode(out).byteLength;
  if (byteLength > maxBytes) {
    throw new ProtocolError(
      ProtocolErrorCode.SIZE_EXCEEDED,
      `canonical form is ${byteLength} bytes, limit is ${maxBytes}`,
    );
  }
  return out;
}

/** Serialize to canonical UTF-8 bytes. This is what gets hashed and signed. */
export function canonicalizeToBytes(
  value: CanonicalValue,
  options: CanonicalizeOptions = {},
): Uint8Array {
  return encoder.encode(canonicalize(value, options));
}

interface SerializeContext {
  readonly maxDepth: number;
  readonly allowNull: boolean;
}

function serialize(
  value: unknown,
  depth: number,
  path: string,
  ctx: SerializeContext,
): string {
  if (depth > ctx.maxDepth) {
    throw new ProtocolError(
      ProtocolErrorCode.DEPTH_EXCEEDED,
      `nesting exceeds depth limit of ${ctx.maxDepth}`,
      path,
    );
  }

  if (value === null) {
    if (!ctx.allowNull) {
      throw new ProtocolError(
        ProtocolErrorCode.UNEXPECTED_NULL,
        "null is not permitted; omit the field instead (ADR-0004)",
        path,
      );
    }
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value, path);
    case "string":
      return serializeString(value, path);
    case "object":
      return Array.isArray(value)
        ? serializeArray(value, depth, path, ctx)
        : serializeObject(value as Record<string, unknown>, depth, path, ctx);
    default:
      throw new ProtocolError(
        ProtocolErrorCode.UNSUPPORTED_TYPE,
        `cannot canonicalize value of type ${typeof value}`,
        path,
      );
  }
}

function serializeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new ProtocolError(
      ProtocolErrorCode.NON_FINITE_NUMBER,
      `NaN and Infinity are not representable in canonical JSON`,
      path,
    );
  }
  if (!Number.isInteger(value)) {
    throw new ProtocolError(
      ProtocolErrorCode.NON_INTEGER_NUMBER,
      "non-integer numbers are not permitted; encode as a string with a documented unit (ADR-0004)",
      path,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new ProtocolError(
      ProtocolErrorCode.UNSAFE_INTEGER,
      `integer ${value} is outside the safe range +/-(2^53 - 1)`,
      path,
    );
  }
  // Object.is distinguishes -0 from 0; JCS serializes both as "0".
  return Object.is(value, -0) ? "0" : String(value);
}

function serializeString(value: string, path: string): string {
  const normalized = normalizeString(value, path);
  // JSON.stringify implements exactly the RFC 8785 string production: escape
  // quote and backslash, use the short forms for \b \t \n \f \r, emit other
  // control characters as lowercase \u00xx, and pass everything else through
  // literally. Reimplementing it would only add a place to be subtly wrong.
  return JSON.stringify(normalized);
}

function normalizeString(value: string, path: string): string {
  assertNoLoneSurrogates(value, path);
  return value.normalize("NFC");
}

function assertNoLoneSurrogates(value: string, path: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        throw new ProtocolError(
          ProtocolErrorCode.LONE_SURROGATE,
          `unpaired high surrogate at index ${i}`,
          path,
        );
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new ProtocolError(
        ProtocolErrorCode.LONE_SURROGATE,
        `unpaired low surrogate at index ${i}`,
        path,
      );
    }
  }
}

function serializeArray(
  value: unknown[],
  depth: number,
  path: string,
  ctx: SerializeContext,
): string {
  const parts: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const element = value[i];
    if (element === undefined) {
      // Omitting an array element would shift every later index, silently
      // changing meaning. Refuse instead.
      throw new ProtocolError(
        ProtocolErrorCode.UNSUPPORTED_TYPE,
        "undefined is not permitted as an array element",
        `${path}/${i}`,
      );
    }
    parts.push(serialize(element, depth + 1, `${path}/${i}`, ctx));
  }
  return `[${parts.join(",")}]`;
}

function serializeObject(
  value: Record<string, unknown>,
  depth: number,
  path: string,
  ctx: SerializeContext,
): string {
  // Undefined-valued properties are omitted. This is what makes "absent, not
  // null" ergonomic in TypeScript, where an optional field is naturally
  // undefined rather than missing.
  const present = Object.keys(value).filter((k) => value[k] !== undefined);

  // NFC normalization can map two distinct keys onto the same canonical key.
  // Detect it rather than silently dropping one.
  const normalized = new Map<string, string>();
  for (const key of present) {
    const nfc = normalizeString(key, `${path}/${key}`);
    const existing = normalized.get(nfc);
    if (existing !== undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.DUPLICATE_KEY,
        `keys ${JSON.stringify(existing)} and ${JSON.stringify(key)} collide after NFC normalization`,
        path,
      );
    }
    normalized.set(nfc, key);
  }

  // RFC 8785 sorts by UTF-16 code unit, which is what JavaScript's default
  // string comparison does.
  const sorted = [...normalized.keys()].sort();

  const parts: string[] = [];
  for (const nfcKey of sorted) {
    const originalKey = normalized.get(nfcKey) as string;
    const child = serialize(
      value[originalKey],
      depth + 1,
      `${path}/${originalKey}`,
      ctx,
    );
    parts.push(`${JSON.stringify(nfcKey)}:${child}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Parse JSON, rejecting duplicate keys.
 *
 * `JSON.parse` silently keeps the last of a duplicated key, so
 * `{"a":1,"a":2}` becomes `{"a":2}` — which re-canonicalizes to different
 * bytes than the sender produced, and therefore fails signature verification
 * with a misleading error. Catching it at parse time gives a truthful one.
 */
export function parseStrict(text: string): CanonicalValue {
  const seen: string[] = [];
  const result = JSON.parse(text, function reviver(this: unknown, key, value) {
    if (key !== "" && typeof this === "object" && this !== null) {
      // The reviver visits each key once even when duplicated, so duplicates
      // are found by scanning the source rather than the parsed result.
      void seen;
    }
    return value as unknown;
  }) as CanonicalValue;

  assertNoDuplicateKeys(text);
  return result;
}

/**
 * Scan raw JSON text for duplicate keys within the same object.
 *
 * A full parse is required because a string value may contain characters that
 * look like structure. This is a small tokenizer, not a regex.
 */
function assertNoDuplicateKeys(text: string): void {
  const stack: Array<Set<string> | null> = [];
  let i = 0;

  const skipWhitespace = (): void => {
    while (i < text.length) {
      const c = text[i] as string;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else break;
    }
  };

  const readString = (): string => {
    // Assumes text[i] === '"'.
    let out = "";
    i++;
    while (i < text.length) {
      const c = text[i] as string;
      if (c === "\\") {
        out += c + (text[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return out;
      }
      out += c;
      i++;
    }
    return out;
  };

  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"') {
      const raw = readString();
      skipWhitespace();
      const top = stack[stack.length - 1];
      if (top instanceof Set && text[i] === ":") {
        if (top.has(raw)) {
          throw new ProtocolError(
            ProtocolErrorCode.DUPLICATE_KEY,
            `duplicate key ${JSON.stringify(raw)}`,
          );
        }
        top.add(raw);
      }
      continue;
    }
    if (c === "{") {
      stack.push(new Set<string>());
    } else if (c === "[") {
      stack.push(null);
    } else if (c === "}" || c === "]") {
      stack.pop();
    }
    i++;
  }
}
