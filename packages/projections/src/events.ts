/**
 * Event types and payload shapes.
 *
 * The canonical vocabulary. Event types are hierarchical dotted names whose first
 * segment is the §33.3 category, so a category can be selected by prefix without
 * a lookup table that would drift.
 *
 * Spec: §33.3, §33.6.
 */
import type {
  BlockAssignment,
  EpochDescriptor,
  PolicyExpression,
  RunTerminationReason,
  RunValidity,
} from "@freeq-foundry/protocol";

export const EventTypes = {
  // controller
  RUN_STARTED: "controller.run_started",
  RUN_CLOCK_PAUSED: "controller.clock_paused",
  RUN_CLOCK_RESUMED: "controller.clock_resumed",
  RUN_VALIDITY_JUDGED: "controller.validity_judged",
  RUN_TERMINATED: "controller.run_terminated",
  SHOCK_APPLIED: "controller.shock_applied",

  // admission
  PARTICIPANT_ADMITTED: "admission.participant_admitted",
  PARTICIPANT_REJECTED: "admission.participant_rejected",
  PARTICIPANT_SUSPENDED: "admission.participant_suspended",
  PARTICIPANT_REINSTATED: "admission.participant_reinstated",

  // provenance
  CREDENTIAL_ISSUED: "provenance.credential_issued",
  CREDENTIAL_REVOKED: "provenance.credential_revoked",

  // communication
  CHANNEL_CREATED: "communication.channel_created",
  CHANNEL_JOINED: "communication.channel_joined",
  MESSAGE_POSTED: "communication.message_posted",

  // governance
  CONSTITUTION_ADOPTED: "governance.constitution_adopted",
  PROPOSAL_OPENED: "governance.proposal_opened",
  PROPOSAL_AMENDED: "governance.proposal_amended",
  PROPOSAL_WITHDRAWN: "governance.proposal_withdrawn",
  VOTE_CAST: "governance.vote_cast",
  PROPOSAL_CLOSED: "governance.proposal_closed",
  PROPOSAL_EXECUTED: "governance.proposal_executed",
  PROPOSAL_EXECUTION_FAILED: "governance.proposal_execution_failed",

  // election
  OFFICE_CREATED: "election.office_created",
  NOMINATION_MADE: "election.nomination_made",
  ELECTION_OPENED: "election.opened",
  ELECTION_DECIDED: "election.decided",
  OFFICE_ASSIGNED: "election.office_assigned",
  OFFICE_VACATED: "election.office_vacated",

  // delegation
  DELEGATION_GRANTED: "delegation.granted",
  DELEGATION_REVOKED: "delegation.revoked",

  // capability
  CAPABILITY_GRANTED: "capability.granted",
  CAPABILITY_REVOKED: "capability.revoked",
  CAPABILITY_ATTENUATED: "capability.attenuated",
  AUTHORIZATION_DECIDED: "capability.authorization_decided",
  ACTION_DENIED: "capability.action_denied",

  // treasury
  BUDGET_ALLOCATED: "treasury.budget_allocated",
  SPEND_RECORDED: "treasury.spend_recorded",
  BUDGET_EXHAUSTED: "treasury.budget_exhausted",

  // work
  WORK_ITEM_OPENED: "work.item_opened",
  WORK_ITEM_CLAIMED: "work.item_claimed",
  WORK_ITEM_COMPLETED: "work.item_completed",

  // repository
  BRANCH_CREATED: "repository.branch_created",
  COMMIT_CREATED: "repository.commit_created",
  PULL_REQUEST_OPENED: "repository.pull_request_opened",
  PULL_REQUEST_REVIEWED: "repository.pull_request_reviewed",
  PULL_REQUEST_MERGED: "repository.pull_request_merged",

  // ci
  CI_COMPLETED: "ci.completed",

  // model
  MODEL_INVOKED: "model.invoked",

  // deployment
  DEPLOYMENT_COMPLETED: "deployment.completed",
  DEPLOYMENT_ROLLED_BACK: "deployment.rolled_back",

  // evaluation
  RELEASE_SUBMITTED: "evaluation.release_submitted",
  RELEASE_VERIFIED: "evaluation.release_verified",
  RELEASE_REJECTED: "evaluation.release_rejected",

  // safety
  SAFETY_EVENT: "safety.event",
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

/** Category of an event type, from its first dotted segment (§33.3). */
export function categoryOf(eventType: string): string {
  return eventType.split(".")[0] ?? "";
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface RunStartedPayload {
  readonly scenarioId: string;
  readonly epoch: EpochDescriptor;
  readonly block?: BlockAssignment;
  readonly horizonMs: number;
  readonly evaluatorDid: string;
  readonly confirmatory: boolean;
  /** Hash of the canonical run manifest, so the design is inside the record. */
  readonly manifestHash: string;
}

export interface ClockPausedPayload {
  readonly reason: string;
}

export interface ValidityJudgedPayload {
  readonly validity: RunValidity;
  readonly reasonCode: string;
  readonly note?: string;
}

export interface RunTerminatedPayload {
  readonly reason: RunTerminationReason;
  readonly note?: string;
}

export interface ParticipantAdmittedPayload {
  readonly did: string;
  readonly participantType: string;
  readonly admissionCredentialId: string;
  readonly terminalHumanDids: readonly string[];
  readonly lineageDepth: number;
  /** Stable per-run pseudonym for the lineage root, per §58.3 `hashed` default. */
  readonly lineagePseudonym: string;
  readonly declaredAutonomy?: "autonomous" | "supervised" | "teleoperated";
}

export interface ParticipantSuspendedPayload {
  readonly did: string;
  readonly reasonCode: string;
  /** Set when suspension follows from an ancestor's revocation (§11.10). */
  readonly causedByCredentialId?: string;
}

export interface MessagePostedPayload {
  readonly channelId: string;
  readonly text: string;
}

export interface ConstitutionAdoptedPayload {
  readonly constitutionId: string;
  readonly version: number;
  readonly rules: readonly ConstitutionRule[];
  readonly supersedes?: string;
}

export interface ConstitutionRule {
  readonly id: string;
  readonly kind: "quorum" | "eligibility" | "capability_bound" | "sunset" | "entrenchment";
  readonly description: string;
  readonly expression: PolicyExpression;
  /** True when this rule cannot be amended by ordinary process (§17.6). */
  readonly entrenched?: boolean;
  /** Logical time after which the rule lapses (§17.7). */
  readonly sunsetAtLogicalTime?: number;
}

export type ProposalKind =
  | "constitution_amendment"
  | "capability_grant"
  | "capability_revoke"
  | "office_create"
  | "budget_allocate"
  | "work_assign"
  | "sanction"
  | "release_authorize";

export interface ProposalOpenedPayload {
  readonly proposalId: string;
  readonly kind: ProposalKind;
  readonly title: string;
  readonly rationale: string;
  /** Executable effects, applied atomically on passage (§16.5). */
  readonly actions: readonly GovernanceAction[];
  /** Rule the proposer claims authorizes this (§16.6). */
  readonly constitutionalBasis?: string;
  readonly closesAtLogicalTime: number;
  readonly dependsOn?: readonly string[];
}

export type GovernanceAction =
  | {
      readonly type: "grant_capability";
      readonly toDid: string;
      readonly namespace: string;
      readonly constraints?: PolicyExpression;
      readonly redelegable?: boolean;
    }
  | { readonly type: "revoke_capability"; readonly grantId: string }
  | {
      readonly type: "amend_constitution";
      readonly addRules?: readonly ConstitutionRule[];
      readonly removeRuleIds?: readonly string[];
    }
  | {
      readonly type: "create_office";
      readonly officeId: string;
      readonly title: string;
      readonly capabilityNamespaces: readonly string[];
      readonly termLogicalTime: number;
    }
  | { readonly type: "allocate_budget"; readonly toDid: string; readonly credits: number }
  | { readonly type: "assign_work"; readonly workItemId: string; readonly toDid: string }
  | { readonly type: "sanction"; readonly targetDid: string; readonly reasonCode: string };

export interface VoteCastPayload {
  readonly proposalId: string;
  readonly choice:
    | { readonly type: "yes" }
    | { readonly type: "no" }
    | { readonly type: "abstain" }
    | { readonly type: "approval"; readonly candidateIds: readonly string[] }
    | { readonly type: "ranking"; readonly candidateIds: readonly string[] };
  readonly delegationId?: string;
  readonly rationale?: string;
}

export interface ProposalClosedPayload {
  readonly proposalId: string;
  readonly outcome: "passed" | "failed";
  readonly tally: {
    readonly yes: number;
    readonly no: number;
    readonly abstain: number;
    readonly eligibleVoters: number;
    readonly distinctLineages: number;
  };
  /** Which quorum rule decided this, and why it was or was not met. */
  readonly quorumRuleId?: string;
  readonly reason: string;
}

export interface ProposalExecutedPayload {
  readonly proposalId: string;
  readonly appliedActions: number;
  readonly grantIds?: readonly string[];
}

export interface OfficeCreatedPayload {
  readonly officeId: string;
  readonly title: string;
  readonly capabilityNamespaces: readonly string[];
  readonly termLogicalTime: number;
  readonly electionMethod: string;
  readonly tieBreaks: readonly string[];
  readonly exclusive?: boolean;
  readonly removalThresholdPct?: number;
}

export interface OfficeAssignedPayload {
  readonly officeId: string;
  readonly holderDid: string;
  readonly expiresAtLogicalTime: number;
  /** Grants issued for the term, revoked when it ends. */
  readonly grantIds: readonly string[];
}

export interface OfficeVacatedPayload {
  readonly officeId: string;
  readonly holderDid: string;
  readonly reason: "term_expired" | "removed" | "resigned" | "suspended";
  readonly revokedGrantIds: readonly string[];
}

export interface NominationPayload {
  readonly officeId: string;
  readonly candidateId: string;
  readonly candidateDid: string;
  readonly statement?: string;
}

export interface CapabilityGrantedPayload {
  readonly grantId: string;
  readonly toDid: string;
  readonly namespace: string;
  readonly constraints?: PolicyExpression;
  readonly redelegable: boolean;
  readonly grantedByProposalId?: string;
  readonly parentGrantId?: string;
  readonly expiresAtLogicalTime?: number;
}

export interface AuthorizationDecidedPayload {
  readonly decisionId: string;
  readonly actorDid: string;
  readonly namespace: string;
  readonly allowed: boolean;
  readonly grantIdsUsed: readonly string[];
  /** Human-readable trace, required by §20.4 so a denial is explicable. */
  readonly reason: string;
}

export interface ActionDeniedPayload {
  readonly actorDid: string;
  readonly attemptedNamespace: string;
  readonly reason: string;
}

export interface SpendRecordedPayload {
  readonly account: string;
  readonly credits: number;
  /** Decimal string: ADR-0004 forbids floats, and money should not be one. */
  readonly usd?: string;
  readonly purpose: "governance" | "production" | "evaluation" | "other";
}

export interface ReleaseVerifiedPayload {
  readonly releaseId: string;
  readonly mandatoryTestsPassed: number;
  readonly mandatoryTestsTotal: number;
  readonly acceptanceFraction: string;
  readonly minimumOperatingPeriodMet: boolean;
  /** Evaluator signature over the result. Governance cannot produce this. */
  readonly evaluatorSignature: string;
}

export interface ReleaseRejectedPayload {
  readonly releaseId: string;
  readonly mandatoryTestsPassed: number;
  readonly mandatoryTestsTotal: number;
  readonly acceptanceFraction: string;
  readonly failures: readonly string[];
}

export interface SafetyEventPayload {
  readonly severity: "info" | "warning" | "severe" | "terminal";
  readonly code: string;
  readonly description: string;
}
