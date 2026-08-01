/**
 * Published conformance vectors.
 *
 * This is the operational definition of protocol conformance. An implementation
 * in any language passes or fails against `vectors/index.json`; nothing about
 * TypeScript is normative.
 *
 * Every vector is data. Chain mutations are expressed as RFC 6902-style patches
 * rather than as prose, so a Go or Python implementer can apply them
 * mechanically instead of interpreting an English description and getting it
 * subtly wrong.
 *
 * Spec: §51.1, §50 Milestone 1.
 */
import { canonicalize, canonicalizeToBytes } from "./canonical.js";
import { ProtocolErrorCode } from "./errors.js";
import { GENESIS_HASH, hashCanonical, hashString } from "./hash.js";
import { keyPairFromSeed, rawPublicKey } from "./keys.js";
import { SigningContext, signPayload, signingInput, type SignableKind } from "./signing.js";
import { buildSampleRun } from "./testing.js";
import type { RecordedEvent } from "./types.js";

export const VECTOR_FORMAT_VERSION = 1;
export const PROTOCOL_ID = "freeq-foundry/v1";

/** A value expressible as JSON text, with its canonical form and digest. */
export interface CanonicalVector {
  readonly name: string;
  readonly note?: string;
  /** Input as JSON text. Parse it, then canonicalize the result. */
  readonly inputJson: string;
  /** Expected canonical form, as UTF-8 text. */
  readonly canonical: string;
  /** Expected canonical form, as lowercase hex of the UTF-8 bytes. */
  readonly canonicalHex: string;
  /** Expected `sha256:`-prefixed digest of the canonical bytes. */
  readonly digest: string;
}

/** A rejection reachable from JSON text. */
export interface InvalidJsonVector {
  readonly name: string;
  readonly note?: string;
  readonly inputJson: string;
  readonly errorCode: string;
}

/**
 * A rejection that requires a host-language value JSON cannot express.
 *
 * `directive` names the condition; an implementer maps it to whatever their
 * language calls it. Describing these in prose would guarantee divergence.
 */
export interface InvalidConstructedVector {
  readonly name: string;
  readonly directive:
    | "nan"
    | "positive-infinity"
    | "undefined-property"
    | "undefined-array-element"
    | "lone-high-surrogate"
    | "lone-low-surrogate";
  readonly description: string;
  readonly errorCode: string;
}

export interface DigestVector {
  readonly name: string;
  readonly inputUtf8: string;
  readonly digest: string;
}

export interface DidKeyVector {
  readonly name: string;
  readonly seedHex: string;
  readonly publicKeyHex: string;
  readonly did: string;
}

export interface InvalidDidVector {
  readonly name: string;
  readonly did: string;
  readonly errorCode: string;
}

export interface SigningVector {
  readonly name: string;
  readonly kind: SignableKind;
  readonly context: string;
  readonly seedHex: string;
  readonly did: string;
  readonly payloadJson: string;
  /** The exact bytes signed: context string followed by canonical payload. */
  readonly signingInputHex: string;
  /** Unpadded base64url Ed25519 signature. */
  readonly signature: string;
}

/** RFC 6902 subset sufficient to express every chain mutation we test. */
export type Patch =
  | { readonly op: "replace"; readonly path: string; readonly value: unknown }
  | { readonly op: "remove"; readonly path: string }
  | { readonly op: "move"; readonly from: string; readonly path: string };

export interface ChainVector {
  readonly name: string;
  readonly note?: string;
  /** Applied to the `events` array before verifying. Empty means verify as-is. */
  readonly patches: readonly Patch[];
  readonly expectValid: boolean;
  /** Error codes that MUST appear among the violations. */
  readonly expectCodes: readonly string[];
  /** Index of the first violation, or -1. */
  readonly expectFirstBadIndex: number;
}

export interface VectorSet {
  readonly formatVersion: number;
  readonly protocol: string;
  readonly generatedBy: string;
  readonly canonicalization: {
    readonly valid: readonly CanonicalVector[];
    readonly invalidJson: readonly InvalidJsonVector[];
    readonly invalidConstructed: readonly InvalidConstructedVector[];
  };
  readonly digests: readonly DigestVector[];
  readonly didKey: {
    readonly valid: readonly DidKeyVector[];
    readonly invalid: readonly InvalidDidVector[];
  };
  readonly signing: {
    readonly contexts: Readonly<Record<string, string>>;
    readonly vectors: readonly SigningVector[];
    /** Every signature MUST fail verification under every other context. */
    readonly crossContextMustFail: boolean;
  };
  readonly events: {
    readonly genesisHash: string;
    readonly recorderDid: string;
    readonly runId: string;
    /** A complete, valid run. */
    readonly events: readonly RecordedEvent[];
    /** The same run as `events.ndjson` (§33.9). */
    readonly ndjson: string;
  };
  readonly chain: readonly ChainVector[];
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function canonicalVector(
  name: string,
  inputJson: string,
  note?: string,
): CanonicalVector {
  const value = JSON.parse(inputJson) as never;
  const canonical = canonicalize(value);
  return {
    name,
    ...(note === undefined ? {} : { note }),
    inputJson,
    canonical,
    canonicalHex: hex(canonicalizeToBytes(value)),
    digest: hashCanonical(value),
  };
}

function signingVector(
  name: string,
  kind: SignableKind,
  seedByte: number,
  payload: Record<string, unknown>,
): SigningVector {
  const seed = new Uint8Array(32).fill(seedByte);
  const keyPair = keyPairFromSeed(seed);
  return {
    name,
    kind,
    context: SigningContext[kind],
    seedHex: hex(seed),
    did: keyPair.did,
    payloadJson: JSON.stringify(payload),
    signingInputHex: hex(signingInput(kind, payload as never)),
    signature: signPayload(kind, payload as never, keyPair.privateKey),
  };
}

/** Build the full vector set. Deterministic: same output on every run. */
export function buildVectorSet(generatedBy: string): VectorSet {
  const run = buildSampleRun("run-vectors-001");

  return {
    formatVersion: VECTOR_FORMAT_VERSION,
    protocol: PROTOCOL_ID,
    generatedBy,

    canonicalization: {
      valid: [
        canonicalVector("empty-object", "{}"),
        canonicalVector("empty-array", "[]"),
        canonicalVector(
          "key-ordering",
          '{"b":1,"a":2,"c":3}',
          "Keys sort by UTF-16 code unit.",
        ),
        canonicalVector(
          "key-ordering-case",
          '{"a":1,"A":2}',
          "Uppercase precedes lowercase, so this is not alphabetical order.",
        ),
        canonicalVector(
          "key-ordering-mixed",
          '{"\\u20ac":1,"\\n":2,"a":3,"1":4}',
          "\\n=10, '1'=49, 'a'=97, '\\u20ac'=8364.",
        ),
        canonicalVector("nested-objects-sort-independently", '{"z":{"b":1,"a":2},"a":3}'),
        canonicalVector("array-order-preserved", "[3,1,2]"),
        canonicalVector("whitespace-removed", '{ "a" : [ 1 , 2 ] }'),
        canonicalVector("booleans", '{"t":true,"f":false}'),
        canonicalVector("negative-integer", '{"n":-42}'),
        canonicalVector("zero", '{"n":0}'),
        canonicalVector("large-safe-integer", '{"n":9007199254740991}'),
        canonicalVector(
          "control-characters",
          '{"s":"\\u0001\\t\\n\\"\\\\"}',
          "Short escapes for \\b \\t \\n \\f \\r; other controls as lowercase \\u00xx.",
        ),
        canonicalVector(
          "non-ascii-literal",
          '{"s":"\\u65e5\\u672c\\u8a9e caf\\u00e9"}',
          "Non-ASCII passes through as UTF-8, not as escapes.",
        ),
        canonicalVector(
          "surrogate-pair",
          '{"s":"\\ud83d\\ude00"}',
          "A valid pair is fine; lone surrogates are not.",
        ),
        canonicalVector(
          "nfc-composed",
          '{"s":"\\u00e9"}',
          "Composed and decomposed forms MUST produce identical output.",
        ),
        canonicalVector("nfc-decomposed", '{"s":"e\\u0301"}'),
        canonicalVector("deep-nesting", '{"a":{"b":{"c":{"d":[1,2,{"e":true}]}}}}'),
      ],

      invalidJson: [
        {
          name: "non-integer-number",
          note: "Encode non-integers as strings with a documented unit.",
          inputJson: '{"n":1.5}',
          errorCode: ProtocolErrorCode.NON_INTEGER_NUMBER,
        },
        {
          name: "unsafe-integer",
          inputJson: '{"n":9007199254740992}',
          errorCode: ProtocolErrorCode.UNSAFE_INTEGER,
        },
        {
          name: "explicit-null",
          note: "Omit the field instead of emitting null.",
          inputJson: '{"a":null}',
          errorCode: ProtocolErrorCode.UNEXPECTED_NULL,
        },
        {
          name: "duplicate-key",
          note: "Must be rejected at parse time, not silently last-wins.",
          inputJson: '{"a":1,"a":2}',
          errorCode: ProtocolErrorCode.DUPLICATE_KEY,
        },
        {
          name: "nfc-colliding-keys",
          note: "Distinct keys that collide after NFC normalization.",
          inputJson: '{"\\u00e9":1,"e\\u0301":2}',
          errorCode: ProtocolErrorCode.DUPLICATE_KEY,
        },
      ],

      invalidConstructed: [
        {
          name: "nan",
          directive: "nan",
          description: "A number field whose value is NaN.",
          errorCode: ProtocolErrorCode.NON_FINITE_NUMBER,
        },
        {
          name: "positive-infinity",
          directive: "positive-infinity",
          description: "A number field whose value is positive infinity.",
          errorCode: ProtocolErrorCode.NON_FINITE_NUMBER,
        },
        {
          name: "undefined-array-element",
          directive: "undefined-array-element",
          description:
            "An array containing a language-level absent value. Omitting it would shift later indices and silently change meaning.",
          errorCode: ProtocolErrorCode.UNSUPPORTED_TYPE,
        },
        {
          name: "lone-high-surrogate",
          directive: "lone-high-surrogate",
          description: "A string containing U+D800 with no following low surrogate.",
          errorCode: ProtocolErrorCode.LONE_SURROGATE,
        },
        {
          name: "lone-low-surrogate",
          directive: "lone-low-surrogate",
          description: "A string containing U+DC00 with no preceding high surrogate.",
          errorCode: ProtocolErrorCode.LONE_SURROGATE,
        },
      ],
    },

    digests: [
      { name: "empty-string", inputUtf8: "", digest: hashString("") },
      { name: "abc", inputUtf8: "abc", digest: hashString("abc") },
      { name: "euro-sign", inputUtf8: "\u20ac", digest: hashString("\u20ac") },
    ],

    didKey: {
      valid: [0, 1, 3, 7, 255].map((fill) => {
        const seed = new Uint8Array(32).fill(fill);
        const keyPair = keyPairFromSeed(seed);
        return {
          name: `seed-all-0x${fill.toString(16).padStart(2, "0")}`,
          seedHex: hex(seed),
          publicKeyHex: hex(rawPublicKey(keyPair.publicKey)),
          did: keyPair.did,
        };
      }),
      invalid: [
        { name: "not-a-did", did: "nonsense", errorCode: ProtocolErrorCode.INVALID_DID },
        {
          name: "unsupported-method",
          did: "did:web:example.com",
          errorCode: ProtocolErrorCode.UNSUPPORTED_DID_METHOD,
        },
        {
          name: "wrong-multibase-prefix",
          did: "did:key:mAAAA",
          errorCode: ProtocolErrorCode.INVALID_DID,
        },
        {
          name: "base58-alphabet-violation",
          did: "did:key:z0OIl",
          errorCode: ProtocolErrorCode.INVALID_BASE58,
        },
      ],
    },

    signing: {
      contexts: { ...SigningContext },
      vectors: [
        signingVector("event-simple", "EVENT", 1, { a: 1, b: "two" }),
        signingVector("event-nested", "EVENT", 2, { x: { b: 1, a: 2 }, y: [1, 2, 3] }),
        signingVector("action", "ACTION", 3, { actionType: "vote", proposalId: "p-1" }),
        signingVector("record", "RECORD", 4, { eventHash: GENESIS_HASH }),
        signingVector("human-root", "HUMAN_ROOT", 5, { subjectDid: "did:key:zExample" }),
        signingVector("agent-creation", "AGENT_CREATION", 6, { relationship: "created" }),
        signingVector("tool-exec", "TOOL_EXEC", 7, { toolName: "repo.commit" }),
        signingVector("evaluation", "EVALUATION", 8, { passed: true }),
        signingVector("challenge", "CHALLENGE", 9, { nonce: "abc123" }),
        signingVector("revocation", "REVOCATION", 10, { reasonCode: "key_compromise" }),
      ],
      crossContextMustFail: true,
    },

    events: {
      genesisHash: GENESIS_HASH,
      recorderDid: run.recorderDid,
      runId: run.runId,
      events: run.events,
      ndjson: run.toNdjson(),
    },

    chain: [
      {
        name: "valid-run",
        patches: [],
        expectValid: true,
        expectCodes: [],
        expectFirstBadIndex: -1,
      },
      {
        name: "payload-altered",
        note: "Naive edit: only the edited event is implicated, because later events still link to what it claimed to be.",
        patches: [{ op: "replace", path: "/3/payload", value: { tampered: true } }],
        expectValid: false,
        expectCodes: [
          ProtocolErrorCode.INVALID_EVENT_HASH,
          ProtocolErrorCode.INVALID_SIGNATURE,
        ],
        expectFirstBadIndex: 3,
      },
      {
        name: "declared-hash-altered",
        patches: [{ op: "replace", path: "/2/eventHash", value: GENESIS_HASH }],
        expectValid: false,
        expectCodes: [ProtocolErrorCode.INVALID_EVENT_HASH],
        expectFirstBadIndex: 2,
      },
      {
        name: "chain-link-rewritten",
        patches: [{ op: "replace", path: "/2/previousEventHash", value: GENESIS_HASH }],
        expectValid: false,
        expectCodes: [ProtocolErrorCode.BROKEN_CHAIN],
        expectFirstBadIndex: 2,
      },
      {
        name: "visibility-widened",
        note: "Reclassifying controller-only material as public (§6.12).",
        patches: [{ op: "replace", path: "/5/visibility", value: { type: "public" } }],
        expectValid: false,
        expectCodes: [ProtocolErrorCode.INVALID_EVENT_HASH],
        expectFirstBadIndex: 5,
      },
      {
        name: "event-removed",
        patches: [{ op: "remove", path: "/3" }],
        expectValid: false,
        expectCodes: [ProtocolErrorCode.BROKEN_CHAIN],
        expectFirstBadIndex: 3,
      },
      {
        name: "events-reordered",
        patches: [{ op: "move", from: "/3", path: "/2" }],
        expectValid: false,
        expectCodes: [ProtocolErrorCode.BROKEN_CHAIN],
        expectFirstBadIndex: 2,
      },
      {
        name: "recorder-signature-cleared",
        note: "Position attestation must be checked, not assumed.",
        patches: [{ op: "replace", path: "/1/recorderSignature", value: "A".repeat(86) }],
        expectValid: false,
        expectCodes: [ProtocolErrorCode.INVALID_RECORDER_SIGNATURE],
        expectFirstBadIndex: 1,
      },
      {
        name: "sequence-replayed",
        note: "Stale and gapped are distinct: a gap means loss, a stale value means replay.",
        patches: [{ op: "replace", path: "/4/participantSequence", value: 1 }],
        expectValid: false,
        expectCodes: [ProtocolErrorCode.STALE_SEQUENCE],
        expectFirstBadIndex: 4,
      },
      {
        name: "logical-time-rewound",
        patches: [{ op: "replace", path: "/2/logicalTime", value: 0 }],
        expectValid: false,
        expectCodes: [ProtocolErrorCode.NON_MONOTONIC_LOGICAL_TIME],
        expectFirstBadIndex: 2,
      },
    ],
  };
}

/** Apply the RFC 6902 subset used by chain vectors. */
export function applyPatches<T>(document: readonly T[], patches: readonly Patch[]): T[] {
  const events = JSON.parse(JSON.stringify(document)) as T[];

  for (const patch of patches) {
    const segments = patch.path.split("/").filter((s) => s !== "");
    if (patch.op === "move") {
      const fromIndex = Number(patch.from.split("/").filter((s) => s !== "")[0]);
      const toIndex = Number(segments[0]);
      const [moved] = events.splice(fromIndex, 1);
      events.splice(toIndex, 0, moved as T);
      continue;
    }

    const index = Number(segments[0]);
    if (segments.length === 1) {
      if (patch.op === "remove") events.splice(index, 1);
      else events[index] = patch.value as T;
      continue;
    }

    let target = events[index] as unknown as Record<string, unknown>;
    for (const segment of segments.slice(1, -1)) {
      target = target[segment] as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1] as string;
    if (patch.op === "remove") delete target[leaf];
    else target[leaf] = patch.value;
  }

  return events;
}
