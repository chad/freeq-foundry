/**
 * @freeq-foundry/protocol
 *
 * Canonical serialization, hashing, signatures, event types, and chain
 * validation for the Freeq Foundry protocol.
 *
 * Zero runtime dependencies by design (ADR-0002): this is the most
 * security-critical package in the system and its audit surface should be
 * readable in one sitting.
 *
 * Spec: §33, §51.1. Decisions: ADR-0004, ADR-0005, ADR-0006.
 */

export {
  canonicalize,
  canonicalizeToBytes,
  parseStrict,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_DEPTH,
  type CanonicalValue,
  type CanonicalizeOptions,
} from "./canonical.js";

export {
  hashBytes,
  hashCanonical,
  hashString,
  isDigest,
  GENESIS_HASH,
  HASH_ALGORITHM,
  HASH_PREFIX,
  type Digest,
} from "./hash.js";

export { base58Decode, base58Encode } from "./base58.js";

export {
  didKeyFromPublicKey,
  didKeyFromRaw,
  generateKeyPair,
  isDidKey,
  keyPairFromSeed,
  publicKeyFromDidKey,
  publicKeyFromRaw,
  rawPublicKey,
  rawPublicKeyFromDidKey,
  DID_KEY_PREFIX,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SEED_BYTES,
  type KeyPair,
} from "./keys.js";

export {
  signPayload,
  signingInput,
  verifyPayload,
  verifyPayloadWithDid,
  SigningContext,
  type SignableKind,
} from "./signing.js";

export {
  computeEventHash,
  sealAndSignEvent,
  sealEvent,
  signEvent,
  verifyEvent,
  type EventVerification,
  type SealOptions,
  type VerifyEventOptions,
} from "./event.js";

export {
  verifyChain,
  SequenceTracker,
  type ChainVerification,
  type ChainViolation,
  type VerifyChainOptions,
} from "./chain.js";

export {
  isProtocolError,
  ProtocolError,
  ProtocolErrorCode,
} from "./errors.js";

export type {
  ActionProvenance,
  CredentialRevocationEvent,
  DiagnosticFinding,
  DraftEvent,
  EventCategory,
  ModelInvocationRecord,
  ParticipantType,
  PolicyExpression,
  SignedActionRequest,
  SignedEvent,
  ToolExecutionRecord,
  UnsignedEvent,
  VisibilityPolicy,
} from "./types.js";
