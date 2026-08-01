/**
 * JSON Schema (2020-12) for the canonical event envelope and payload records.
 *
 * §33.6 requires every event type to have a versioned JSON Schema, a
 * compatibility policy, validation tests, human-readable documentation, and a
 * migration strategy. Schemas are a *published artifact* of the protocol, not an
 * implementation detail — external implementers validate against them.
 *
 * Written by hand rather than derived from TypeScript at build time, for two
 * reasons. Generators emit schemas shaped by the type system's quirks rather than
 * by the wire format, and they cannot express the ADR-0004 restrictions —
 * integers only, absent rather than null, no additional properties — which are
 * precisely the parts an external implementer most needs stated. The drift risk
 * is real, so `schema.test.ts` validates the published conformance vectors
 * against these schemas: a type change that alters the wire format fails there.
 *
 * Spec: §33.1, §33.6, §56.
 */

/** Bumped when a schema changes in a way that is not backwards compatible. */
export const SCHEMA_VERSION = 1;

export const SCHEMA_BASE_URI = "https://freeq.ai/foundry/schemas/v1";

const DIGEST_PATTERN = "^sha256:[0-9a-f]{64}$";
const BASE64URL_PATTERN = "^[A-Za-z0-9_-]+$";
const DID_PATTERN = "^did:[a-z0-9]+:.+$";

/** A JSON Schema document. Loose by necessity; the schemas themselves are strict. */
export type JsonSchema = Record<string, unknown>;

/**
 * ADR-0004 forbids non-integer numbers in canonical payloads, so every numeric
 * field is an integer within the double-safe range.
 */
const safeInteger = (minimum = 0): JsonSchema => ({
  type: "integer",
  minimum,
  maximum: Number.MAX_SAFE_INTEGER,
});

const digest = (description: string): JsonSchema => ({
  type: "string",
  pattern: DIGEST_PATTERN,
  description,
});

const did = (description: string): JsonSchema => ({
  type: "string",
  pattern: DID_PATTERN,
  description,
});

const didArray = (description: string): JsonSchema => ({
  type: "array",
  items: did("A participant DID."),
  description,
});

const stringArray = (description: string): JsonSchema => ({
  type: "array",
  items: { type: "string" },
  description,
});

export const participantTypeSchema: JsonSchema = {
  $id: `${SCHEMA_BASE_URI}/participant-type.json`,
  title: "ParticipantType",
  description: "Spec §8.5–§8.10.",
  type: "string",
  enum: [
    "human",
    "agent",
    "organization_service",
    "controller",
    "evaluator",
    "observer",
  ],
};

export const eventCategorySchema: JsonSchema = {
  $id: `${SCHEMA_BASE_URI}/event-category.json`,
  title: "EventCategory",
  description: "Spec §33.3.",
  type: "string",
  enum: [
    "identity",
    "provenance",
    "admission",
    "communication",
    "governance",
    "election",
    "delegation",
    "capability",
    "treasury",
    "work",
    "repository",
    "ci",
    "deployment",
    "evaluation",
    "model",
    "safety",
    "controller",
    "observation",
  ],
};

/**
 * Spec §33.7. Five levels, discriminated by `type`.
 *
 * `oneOf` rather than `anyOf`: a visibility policy matching two branches is
 * ambiguous, and ambiguity about who can see something is a privacy failure.
 */
export const visibilityPolicySchema: JsonSchema = {
  $id: `${SCHEMA_BASE_URI}/visibility-policy.json`,
  title: "VisibilityPolicy",
  description: "Spec §33.7, §6.12.",
  oneOf: [
    {
      type: "object",
      properties: { type: { const: "public" } },
      required: ["type"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { type: { const: "channel" }, channelId: { type: "string" } },
      required: ["type", "channelId"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "participants" },
        participantDids: didArray("Participants who may see this event."),
      },
      required: ["type", "participantDids"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "lineage" },
        terminalHumanDid: did("Root of the lineage that may see this event."),
      },
      required: ["type", "terminalHumanDid"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { type: { const: "controller" } },
      required: ["type"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "post_run_reveal" },
        revealPolicyId: { type: "string" },
      },
      required: ["type", "revealPolicyId"],
      additionalProperties: false,
    },
  ],
};

/**
 * Spec §33.2.
 *
 * Note §11.5: `signerDid`, `terminalHumanDids`, and `directInstructionEventIds`
 * answer three different questions and may name different identities. The schema
 * requires all three so that an implementation cannot quietly omit the ones that
 * make autonomy claims checkable.
 */
export const actionProvenanceSchema: JsonSchema = {
  $id: `${SCHEMA_BASE_URI}/action-provenance.json`,
  title: "ActionProvenance",
  description: "The attribution envelope required by §6.4.",
  type: "object",
  properties: {
    signerDid: did("Who signed the content."),
    terminalHumanDids: didArray("Human roots of the signer's lineage (§6.2)."),
    provenancePathHashes: stringArray("Hashes of the credential chain edges."),
    admissionCredentialId: { type: "string" },
    directInstructionEventIds: stringArray(
      "Signed instructions that prompted this action. Distinct from creation provenance (§11.5).",
    ),
    modelInvocationId: { type: "string" },
    modelProvider: { type: "string" },
    modelIdentifier: { type: "string" },
    governanceAuthorizationIds: stringArray("Governance decisions relied upon."),
    capabilityGrantIds: stringArray("Capability grants exercised (§20)."),
    authorizationDecisionId: { type: "string" },
    toolExecutionId: { type: "string" },
  },
  required: [
    "signerDid",
    "terminalHumanDids",
    "provenancePathHashes",
    "admissionCredentialId",
    "directInstructionEventIds",
    "governanceAuthorizationIds",
    "capabilityGrantIds",
  ],
  additionalProperties: false,
};

/** Fields present at every stage of attestation. */
const eventContentProperties: Record<string, JsonSchema> = {
  eventId: { type: "string", minLength: 1 },
  runId: { type: "string", minLength: 1 },
  eventType: { type: "string", minLength: 1 },
  schemaVersion: safeInteger(1),
  actorDid: did("Participant on whose behalf the event is recorded."),
  participantType: { $ref: `${SCHEMA_BASE_URI}/participant-type.json` },
  participantSequence: {
    ...safeInteger(1),
    description:
      "Per-(runId, actorDid), starting at 1, no gaps. Distinguishes replay from loss (§33.4).",
  },
  wallTime: { type: "string", format: "date-time" },
  payload: {},
  visibility: { $ref: `${SCHEMA_BASE_URI}/visibility-policy.json` },
  causationId: { type: "string" },
  correlationId: { type: "string" },
  references: stringArray(
    "Related event IDs. Named `references` on the wire; stored as event_references because it is a SQL reserved word (ADR-0006).",
  ),
  provenance: { $ref: `${SCHEMA_BASE_URI}/action-provenance.json` },
};

const eventContentRequired = [
  "eventId",
  "runId",
  "eventType",
  "schemaVersion",
  "actorDid",
  "participantType",
  "participantSequence",
  "wallTime",
  "payload",
  "visibility",
  "references",
  "provenance",
];

/**
 * Content signed by the participant, before the recorder assigns a position.
 *
 * Deliberately has no `logicalTime`: canonical append order is logical time and
 * only the recorder may assign it (ADR-0008). A submission carrying one would be
 * a client attempting to place itself in history.
 */
export const attributedEventSchema: JsonSchema = {
  $id: `${SCHEMA_BASE_URI}/attributed-event.json`,
  title: "AttributedEvent",
  description:
    "A participant-attested, unpositioned event. This is the submission format (ADR-0008).",
  type: "object",
  properties: {
    ...eventContentProperties,
    signature: {
      type: "string",
      pattern: BASE64URL_PATTERN,
      description:
        "Ed25519 over FREEQ-FOUNDRY-V1-EVENT + JCS(content), unpadded base64url.",
    },
  },
  required: [...eventContentRequired, "signature"],
  // No `logicalTime`, `previousEventHash`, `eventHash`, or `recorderSignature`:
  // additionalProperties false makes supplying them an error rather than
  // something silently ignored.
  additionalProperties: false,
};

/** Spec §33.1. The complete canonical event, carrying both attestations. */
export const recordedEventSchema: JsonSchema = {
  $id: `${SCHEMA_BASE_URI}/recorded-event.json`,
  title: "RecordedEvent",
  description: "The canonical event of §33.1, with both attestations (ADR-0008).",
  type: "object",
  properties: {
    ...eventContentProperties,
    logicalTime: {
      ...safeInteger(0),
      description: "Canonical append position. Assigned by the recorder (§33.4).",
    },
    previousEventHash: digest(
      "Hash of the preceding event, or sha256: followed by 64 zeros for the genesis event.",
    ),
    eventHash: digest("SHA-256 of JCS(event minus eventHash minus recorderSignature)."),
    signature: {
      type: "string",
      pattern: BASE64URL_PATTERN,
      description: "Participant attestation of content.",
    },
    recorderSignature: {
      type: "string",
      pattern: BASE64URL_PATTERN,
      description: "Recorder attestation of position (ADR-0008).",
    },
  },
  required: [
    ...eventContentRequired,
    "logicalTime",
    "previousEventHash",
    "eventHash",
    "signature",
    "recorderSignature",
  ],
  additionalProperties: false,
};

/** Spec §56.1. */
export const signedActionRequestSchema: JsonSchema = {
  $id: `${SCHEMA_BASE_URI}/signed-action-request.json`,
  title: "SignedActionRequest",
  description: "Spec §56.1. Note the absence of logicalTime.",
  type: "object",
  properties: {
    actionId: { type: "string", minLength: 1 },
    runId: { type: "string", minLength: 1 },
    actorDid: did("Requesting participant."),
    actionType: { type: "string", minLength: 1 },
    payload: {},
    participantSequence: safeInteger(1),
    issuedAt: { type: "string", format: "date-time" },
    expiresAt: { type: "string", format: "date-time" },
    causationId: { type: "string" },
    signature: { type: "string", pattern: BASE64URL_PATTERN },
  },
  required: [
    "actionId",
    "runId",
    "actorDid",
    "actionType",
    "payload",
    "participantSequence",
    "issuedAt",
    "signature",
  ],
  additionalProperties: false,
};

/** Spec §56.6. */
export const diagnosticFindingSchema: JsonSchema = {
  $id: `${SCHEMA_BASE_URI}/diagnostic-finding.json`,
  title: "DiagnosticFinding",
  description: "Spec §56.6.",
  type: "object",
  properties: {
    code: { type: "string", minLength: 1 },
    severity: { type: "string", enum: ["info", "warning", "error", "fatal"] },
    component: {
      type: "string",
      enum: [
        "identity",
        "provenance",
        "network",
        "protocol",
        "admission",
        "capability",
        "event_processing",
        "health",
      ],
    },
    path: { type: "string" },
    explanation: { type: "string", minLength: 1 },
    evidenceRefs: stringArray("Events or artifacts supporting this finding."),
    remediation: { type: "string" },
  },
  required: ["code", "severity", "component", "explanation", "evidenceRefs"],
  additionalProperties: false,
};

/**
 * Spec §56.4, extended by ADR-0009.
 *
 * `costUsd` is a string because ADR-0004 forbids floats, and money should not be
 * a binary float regardless. Same for `temperature`.
 */
export const modelInvocationRecordSchema: JsonSchema = {
  $id: `${SCHEMA_BASE_URI}/model-invocation-record.json`,
  title: "ModelInvocationRecord",
  description: "Spec §56.4, with the ADR-0009 snapshot pin.",
  type: "object",
  properties: {
    id: { type: "string" },
    runId: { type: "string" },
    participantDid: did("Participant the invocation was made for."),
    activationId: { type: "string" },
    adapterId: { type: "string" },
    provider: { type: "string" },
    modelIdentifier: { type: "string" },
    inputArtifactHash: { type: "string" },
    outputArtifactHash: { type: "string" },
    inputTokens: safeInteger(0),
    outputTokens: safeInteger(0),
    latencyMs: safeInteger(0),
    costUsd: {
      type: "string",
      pattern: "^-?[0-9]+(\\.[0-9]+)?$",
      description: "Decimal string, not a float (ADR-0004).",
    },
    budgetAccount: { type: "string" },
    status: { type: "string", enum: ["started", "succeeded", "failed"] },
    failoverFrom: { type: "string" },
    snapshot: {
      type: "object",
      description: "Pinned snapshot and verification level (ADR-0009).",
      properties: {
        provider: { type: "string" },
        modelIdentifier: { type: "string" },
        snapshotIdentifier: { type: "string" },
        apiVersion: { type: "string" },
        systemPromptHash: digest("Hash of the system prompt in force."),
        toolSchemaHash: digest("Hash of the tool schemas offered."),
        temperature: {
          type: "string",
          pattern: "^[0-9]+(\\.[0-9]+)?$",
          description: "Decimal string, not a float.",
        },
        reasoningParameters: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        returnedModelIdentifier: {
          type: "string",
          description:
            "What the provider actually returned. A mismatch with snapshotIdentifier is silent endpoint substitution (ADR-0009).",
        },
        invokedAt: { type: "string", format: "date-time" },
        verificationLevel: {
          type: "integer",
          minimum: 0,
          maximum: 4,
          description:
            "0 unreported, 1 self-reported, 2 runtime-attested, 3 provider receipt, 4 platform-mediated. Condition assignment MUST NOT depend on 0–1.",
        },
      },
      required: [
        "provider",
        "modelIdentifier",
        "snapshotIdentifier",
        "apiVersion",
        "systemPromptHash",
        "toolSchemaHash",
        "invokedAt",
        "verificationLevel",
      ],
      additionalProperties: false,
    },
  },
  required: [
    "id",
    "runId",
    "participantDid",
    "activationId",
    "adapterId",
    "provider",
    "modelIdentifier",
    "inputArtifactHash",
    "budgetAccount",
    "status",
  ],
  additionalProperties: false,
};

/** Every published schema, by `$id`. */
export const schemas: readonly JsonSchema[] = [
  participantTypeSchema,
  eventCategorySchema,
  visibilityPolicySchema,
  actionProvenanceSchema,
  attributedEventSchema,
  recordedEventSchema,
  signedActionRequestSchema,
  diagnosticFindingSchema,
  modelInvocationRecordSchema,
];

export function schemaById(id: string): JsonSchema | undefined {
  return schemas.find((schema) => schema["$id"] === id);
}

/**
 * The compatibility policy §33.6 requires, stated rather than implied.
 *
 * Machine-readable so it ships in the export bundle alongside the schemas, and
 * so the rules cannot quietly diverge from a paragraph in a README.
 */
export const COMPATIBILITY_POLICY = {
  schemaVersion: SCHEMA_VERSION,
  /** Changes permitted without a version bump. */
  backwardsCompatible: [
    "adding an optional property",
    "adding a value to an enum used only in payloads, not in the envelope",
    "relaxing a maximum or widening a pattern",
    "adding documentation",
  ],
  /** Changes requiring a schema version bump and a migration note. */
  breaking: [
    "adding or removing a required property",
    "removing a property",
    "narrowing a type, pattern, or enum",
    "renaming a property",
    "changing canonical serialization, hashing, or any signing context",
  ],
  /**
   * Why the envelope is `additionalProperties: false`.
   *
   * An unknown field would be covered by `eventHash` and therefore by both
   * signatures, so a verifier that tolerated it would accept content it does not
   * understand as attested. Strictness here is a security property, not
   * fastidiousness.
   */
  strictEnvelopeRationale:
    "Unknown envelope fields are covered by eventHash and both signatures. Tolerating them would mean attesting to content the verifier cannot interpret.",
  migration:
    "Breaking changes bump SCHEMA_VERSION and ship a migration note. Historical events are never rewritten (§6.8); projectors handle multiple schema versions.",
} as const;
