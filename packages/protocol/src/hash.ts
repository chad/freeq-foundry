/**
 * Hashing — SHA-256, lowercase hex, `sha256:` prefixed.
 *
 * The prefix costs nine bytes and turns a future algorithm migration into a
 * validation change rather than a format change.
 *
 * Spec: §33.5, §35.4. Decision: ADR-0004.
 */
import { createHash } from "node:crypto";
import { canonicalizeToBytes, type CanonicalValue, type CanonicalizeOptions } from "./canonical.js";

export const HASH_ALGORITHM = "sha256" as const;
export const HASH_PREFIX = "sha256:" as const;

/** A `sha256:`-prefixed lowercase hex digest. */
export type Digest = `sha256:${string}`;

/**
 * The chain anchor for the first event of a run: `sha256:` followed by 64
 * zeros. A distinguished value rather than an absent field, so the genesis
 * event has the same shape as every other event and the same code path
 * validates it.
 */
export const GENESIS_HASH: Digest = `${HASH_PREFIX}${"0".repeat(64)}`;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isDigest(value: unknown): value is Digest {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

/** Hash raw bytes. */
export function hashBytes(bytes: Uint8Array): Digest {
  const hex = createHash(HASH_ALGORITHM).update(bytes).digest("hex");
  return `${HASH_PREFIX}${hex}`;
}

/** Hash a UTF-8 string. */
export function hashString(text: string): Digest {
  return hashBytes(new TextEncoder().encode(text));
}

/** Canonicalize a value, then hash the resulting bytes. */
export function hashCanonical(
  value: CanonicalValue,
  options?: CanonicalizeOptions,
): Digest {
  return hashBytes(canonicalizeToBytes(value, options));
}
