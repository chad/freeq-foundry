/**
 * Core protocol types.
 *
 * Field names match the specification exactly, including `references`, which
 * is a reserved word in SQL and is therefore stored in a column named
 * `event_references` (ADR-0006). The wire name does not change.
 *
 * Spec: §33.1, §33.2, §33.3, §33.7, §56.
 */
import type { Digest } from "./hash.js";

/** Spec §8.5–§8.10. */
export type ParticipantType =
  | "human"
  | "agent"
  | "organization_service"
  | "controller"
  | "evaluator"
  | "observer";

/** Spec §33.3. */
export type EventCategory =
  | "identity"
  | "provenance"
  | "admission"
  | "communication"
  | "governance"
  | "election"
  | "delegation"
  | "capability"
  | "treasury"
  | "work"
  | "repository"
  | "ci"
  | "deployment"
  | "evaluation"
  | "model"
  | "safety"
  | "controller"
  | "observation";

/** Spec §33.7. Five levels, deliberately distinct — see §6.12. */
export type VisibilityPolicy =
  | { readonly type: "public" }
  | { readonly type: "channel"; readonly channelId: string }
  | { readonly type: "participants"; readonly participantDids: readonly string[] }
  | { readonly type: "lineage"; readonly terminalHumanDid: string }
  | { readonly type: "controller" }
  | { readonly type: "post_run_reveal"; readonly revealPolicyId: string };

/**
 * The attribution envelope required by §6.4.
 *
 * Note §11.5: creation provenance, instruction provenance, and operational
 * control are distinct and may point at different identities. `signerDid` is
 * who signed; `terminalHumanDids` is the lineage root; `directInstructionEventIds`
 * is what actually prompted this action. Collapsing them corrupts every
 * downstream research claim about autonomy.
 */
export interface ActionProvenance {
  readonly signerDid: string;
  readonly terminalHumanDids: readonly string[];
  readonly provenancePathHashes: readonly string[];
  readonly admissionCredentialId: string;
  readonly directInstructionEventIds: readonly string[];
  readonly modelInvocationId?: string;
  readonly modelProvider?: string;
  readonly modelIdentifier?: string;
  readonly governanceAuthorizationIds: readonly string[];
  readonly capabilityGrantIds: readonly string[];
  readonly authorizationDecisionId?: string;
  readonly toolExecutionId?: string;
}

/**
 * Event content, before anyone has attested to it.
 *
 * `logicalTime` is absent because canonical append order *is* logical time and
 * only the recorder may assign it (§33.4). A client that could set it could
 * reorder history.
 */
export interface DraftEvent<T = unknown> {
  readonly eventId: string;
  readonly runId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly actorDid: string;
  readonly participantType: ParticipantType;
  readonly participantSequence: number;
  readonly wallTime: string;
  readonly payload: T;
  readonly visibility: VisibilityPolicy;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly references: readonly string[];
  readonly provenance: ActionProvenance;
}

/**
 * Content attested by the participant: "I said this."
 *
 * The signature covers content only, not position, so it is stable wherever the
 * event lands. That is what lets a participant sign without first asking the
 * recorder where the event will go (ADR-0008).
 */
export interface AttributedEvent<T = unknown> extends DraftEvent<T> {
  readonly signature: string;
}

/** Positioned in the chain and hashed, but not yet attested by the recorder. */
export interface PositionedEvent<T = unknown> extends AttributedEvent<T> {
  readonly logicalTime: number;
  readonly previousEventHash: Digest;
  readonly eventHash: Digest;
}

/**
 * A complete canonical event (§33.1), carrying both attestations.
 *
 * `signature` is the participant's, over content. `recorderSignature` is the
 * recorder's, over the positioned event including that signature. Neither party
 * can forge the other's claim (ADR-0008).
 *
 * The four stages are distinct types so an under-attested event cannot be
 * appended by mistake — the type system enforces what would otherwise be a
 * review comment.
 */
export interface RecordedEvent<T = unknown> extends PositionedEvent<T> {
  readonly recorderSignature: string;
}

/** Spec §33.1 calls this the canonical event. */
export type ExperimentEvent<T = unknown> = RecordedEvent<T>;

/** Spec §56.1. */
export interface SignedActionRequest<T = unknown> {
  readonly actionId: string;
  readonly runId: string;
  readonly actorDid: string;
  readonly actionType: string;
  readonly payload: T;
  readonly participantSequence: number;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly causationId?: string;
  readonly signature: string;
}

/** Spec §56.3. */
export interface ToolExecutionRecord {
  readonly id: string;
  readonly actionId: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly actorDid: string;
  readonly authorizationDecisionId: string;
  readonly inputHash: string;
  readonly outputHash?: string;
  readonly status: "started" | "succeeded" | "failed" | "partially_succeeded";
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly safeError?: { readonly code: string; readonly message: string };
  readonly signature: string;
}

/**
 * Spec §56.4.
 *
 * `costUsd` is a decimal string, not a number: ADR-0004 forbids floats in
 * canonical payloads, and money is exactly the case where binary floating point
 * is wrong anyway.
 */
export interface ModelInvocationRecord {
  readonly id: string;
  readonly runId: string;
  readonly participantDid: string;
  readonly activationId: string;
  readonly adapterId: string;
  readonly provider: string;
  readonly modelIdentifier: string;
  readonly inputArtifactHash: string;
  readonly outputArtifactHash?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly latencyMs?: number;
  readonly costUsd?: string;
  readonly budgetAccount: string;
  readonly status: "started" | "succeeded" | "failed";
  readonly failoverFrom?: string;
}

/** Spec §56.5. */
export interface CredentialRevocationEvent {
  readonly credentialId: string;
  readonly revokerDid: string;
  readonly reasonCode:
    | "key_compromise"
    | "operator_request"
    | "policy_violation"
    | "expired_relationship"
    | "controller_action"
    | "other";
  readonly reasonText?: string;
  readonly effectiveAt: string;
  readonly affectedParticipantDids: readonly string[];
}

/** Spec §56.6. */
export interface DiagnosticFinding {
  readonly code: string;
  readonly severity: "info" | "warning" | "error" | "fatal";
  readonly component:
    | "identity"
    | "provenance"
    | "network"
    | "protocol"
    | "admission"
    | "capability"
    | "event_processing"
    | "health";
  readonly path?: string;
  readonly explanation: string;
  readonly evidenceRefs: readonly string[];
  readonly remediation?: string;
}

/**
 * Spec §17.3, §58.11.
 *
 * Opaque until Milestone 4. ADR-0007 defers the language choice; until then
 * nothing may pattern-match on `source`. The `language` tag lets multiple
 * languages coexist and keeps historical expressions interpretable after a
 * migration.
 */
export interface PolicyExpression {
  readonly language: string;
  readonly source: string;
  readonly sourceHash: string;
}
