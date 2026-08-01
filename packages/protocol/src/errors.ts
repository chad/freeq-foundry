/**
 * Protocol error codes.
 *
 * Every rejection has a distinct, stable code. Conformance vectors reference
 * these codes directly, so an implementation in another language can assert not
 * merely that a value was rejected but that it was rejected for the right
 * reason. Renaming a code is a breaking protocol change.
 *
 * Spec: §33.4 (event ordering and gateway rejections).
 */
export const ProtocolErrorCode = {
  // Canonical serialization — ADR-0004
  NON_INTEGER_NUMBER: "NON_INTEGER_NUMBER",
  NON_FINITE_NUMBER: "NON_FINITE_NUMBER",
  UNSAFE_INTEGER: "UNSAFE_INTEGER",
  UNSUPPORTED_TYPE: "UNSUPPORTED_TYPE",
  UNEXPECTED_NULL: "UNEXPECTED_NULL",
  DUPLICATE_KEY: "DUPLICATE_KEY",
  LONE_SURROGATE: "LONE_SURROGATE",
  DEPTH_EXCEEDED: "DEPTH_EXCEEDED",
  SIZE_EXCEEDED: "SIZE_EXCEEDED",

  // Keys, DIDs, signatures — ADR-0003, ADR-0005
  INVALID_DID: "INVALID_DID",
  UNSUPPORTED_DID_METHOD: "UNSUPPORTED_DID_METHOD",
  UNSUPPORTED_KEY_TYPE: "UNSUPPORTED_KEY_TYPE",
  INVALID_KEY_LENGTH: "INVALID_KEY_LENGTH",
  INVALID_BASE58: "INVALID_BASE58",
  INVALID_SIGNATURE_ENCODING: "INVALID_SIGNATURE_ENCODING",
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
  SIGNER_MISMATCH: "SIGNER_MISMATCH",
  MISSING_SIGNATURE: "MISSING_SIGNATURE",

  // Events and chain — §33.4, §33.5
  INVALID_EVENT_HASH: "INVALID_EVENT_HASH",
  BROKEN_CHAIN: "BROKEN_CHAIN",
  INVALID_GENESIS: "INVALID_GENESIS",
  DUPLICATE_EVENT_ID: "DUPLICATE_EVENT_ID",
  STALE_SEQUENCE: "STALE_SEQUENCE",
  GAPPED_SEQUENCE: "GAPPED_SEQUENCE",
  NON_MONOTONIC_LOGICAL_TIME: "NON_MONOTONIC_LOGICAL_TIME",
  RUN_MISMATCH: "RUN_MISMATCH",
  MALFORMED_EVENT: "MALFORMED_EVENT",
} as const;

export type ProtocolErrorCode =
  (typeof ProtocolErrorCode)[keyof typeof ProtocolErrorCode];

/** Structured, machine-readable protocol failure. */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  /** JSON Pointer-ish path to the offending value, when one applies. */
  readonly path: string | undefined;

  constructor(code: ProtocolErrorCode, message: string, path?: string) {
    super(path === undefined ? message : `${message} (at ${path})`);
    this.name = "ProtocolError";
    this.code = code;
    this.path = path;
  }
}

export function isProtocolError(
  value: unknown,
  code?: ProtocolErrorCode,
): value is ProtocolError {
  if (!(value instanceof ProtocolError)) return false;
  return code === undefined || value.code === code;
}
