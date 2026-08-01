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
  attestEvent,
  attestPositionAndRecord,
  computeEventHash,
  positionEvent,
  recordEvent,
  verifyEvent,
  type EventVerification,
  type PositionOptions,
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
  AttributedEvent,
  CredentialRevocationEvent,
  DiagnosticFinding,
  DraftEvent,
  EventCategory,
  ExperimentEvent,
  ModelInvocationRecord,
  ParticipantType,
  PolicyExpression,
  PositionedEvent,
  RecordedEvent,
  SignedActionRequest,
  ToolExecutionRecord,
  VisibilityPolicy,
} from "./types.js";

export {
  CONFIRMATORY_MIN_VERIFICATION_LEVEL,
  DEFAULT_HORIZON_MS,
  MAX_SECONDARY_METRICS,
  ModelVerificationLevel,
  RunTerminationReason,
  RunValidity,
  checkValidityBlindness,
  impliedValidity,
  isConfirmatoryGrade,
  isOrganizationalFailure,
  isSnapshotSubstituted,
  productiveTimeMs,
  restrictedTimeMs,
  runClockMs,
  validateMetricRegistry,
  type BlockAssignment,
  type ClockPause,
  type EpochDescriptor,
  type MetricDefinition,
  type MetricTier,
  type ModelSnapshotPin,
  type RunManifest,
  type RunOutcome,
} from "./research.js";

export {
  buildSampleRun,
  deterministicKeyPair,
  parseNdjson,
  testParticipant,
  TestRunBuilder,
  type AppendSpec,
  type TestParticipant,
} from "./testing.js";
