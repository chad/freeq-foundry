/**
 * Capability authorization.
 *
 * Enforces the [§6.5] no-ambient-authority invariant: joining grants nothing.
 * Every repository, deployment, treasury, and secret operation requires a signed
 * grant, and the authorizer is the only thing that says yes.
 *
 * Two properties matter more than anything else here:
 *
 *   - **Default deny.** Absence of a grant is a denial, and so is a grant whose
 *     constraint cannot be evaluated. There is no fail-open path.
 *   - **Every decision is explicable.** §20.4 requires an authorization trace, so
 *     a denial can be understood rather than merely observed. A refusal nobody can
 *     explain is indistinguishable from a bug.
 *
 * Spec: §20.
 */
import { evaluatePolicy, narrows, type Decision as PolicyDecision } from "@freeq-foundry/policy";
import type { CapabilitiesState, GrantState } from "@freeq-foundry/projections";

/**
 * Capability namespaces (§20.2).
 *
 * Hierarchical dotted names. A grant on `repo` covers `repo.commit`, so authority
 * can be delegated coarsely and attenuated finely.
 */
export const CapabilityNamespaces = {
  REPO: "repo",
  REPO_READ: "repo.read",
  REPO_BRANCH: "repo.branch",
  REPO_COMMIT: "repo.commit",
  REPO_MERGE: "repo.merge",
  REPO_REVIEW: "repo.review",

  DEPLOY: "deploy",
  DEPLOY_PREVIEW: "deploy.preview",
  DEPLOY_PRODUCTION: "deploy.production",
  DEPLOY_ROLLBACK: "deploy.rollback",

  TREASURY: "treasury",
  TREASURY_ALLOCATE: "treasury.allocate",
  TREASURY_SPEND: "treasury.spend",

  GOVERNANCE: "governance",
  GOVERNANCE_PROPOSE: "governance.propose",
  GOVERNANCE_EXECUTE: "governance.execute",
  GOVERNANCE_GRANT: "governance.grant",

  SECRET: "secret",
  SECRET_READ: "secret.read",

  WORK: "work",
  WORK_ASSIGN: "work.assign",

  MODEL: "model",
  MODEL_PREMIUM: "model.premium",
} as const;

export type CapabilityNamespace = string;

/** All namespaces, for validating a grant names something real. */
export const KNOWN_NAMESPACES: readonly string[] = Object.values(CapabilityNamespaces);

/**
 * Does a grant on `granted` cover a request for `requested`?
 *
 * Prefix containment on dotted segments. `repo` covers `repo.commit`; `repo.commit`
 * does not cover `repo`, and `repo.commit` does not cover `repo.commit_all` —
 * matching must be segment-wise, or a namespace could be widened by naming.
 */
export function namespaceCovers(granted: string, requested: string): boolean {
  if (granted === requested) return true;
  return requested.startsWith(`${granted}.`);
}

export interface AuthorizationRequest {
  readonly actorDid: string;
  readonly namespace: string;
  /** Attributes for evaluating grant constraints (§20.3). */
  readonly context?: Readonly<Record<string, string | number | boolean>>;
  readonly atLogicalTime: number;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly actorDid: string;
  readonly namespace: string;
  /** Grants relied upon. Empty on denial. */
  readonly grantIdsUsed: readonly string[];
  /** Why, in terms a human can act on (§20.4). */
  readonly reason: string;
  /** Per-grant detail, so a near-miss is diagnosable. */
  readonly considered: readonly ConsideredGrant[];
}

export interface ConsideredGrant {
  readonly grantId: string;
  readonly namespace: string;
  readonly outcome: "used" | "namespace_mismatch" | "revoked" | "expired" | "constraint_failed";
  readonly detail?: string;
}

/**
 * Decide whether an action is authorized.
 *
 * Pure: takes projected state and returns a decision. Recording the decision as
 * an event is the caller's job, which keeps this function replayable.
 */
export function authorize(
  capabilities: CapabilitiesState,
  request: AuthorizationRequest,
): AuthorizationDecision {
  const considered: ConsideredGrant[] = [];

  for (const grant of capabilities.grants.values()) {
    if (grant.toDid !== request.actorDid) continue;

    if (!namespaceCovers(grant.namespace, request.namespace)) {
      considered.push({
        grantId: grant.grantId,
        namespace: grant.namespace,
        outcome: "namespace_mismatch",
      });
      continue;
    }

    if (grant.revoked) {
      considered.push({
        grantId: grant.grantId,
        namespace: grant.namespace,
        outcome: "revoked",
      });
      continue;
    }

    if (
      grant.expiresAtLogicalTime !== undefined &&
      grant.expiresAtLogicalTime <= request.atLogicalTime
    ) {
      considered.push({
        grantId: grant.grantId,
        namespace: grant.namespace,
        outcome: "expired",
        detail: `expired at logical time ${grant.expiresAtLogicalTime}`,
      });
      continue;
    }

    const constraint = grant.constraints;
    if (constraint !== undefined) {
      const decision: PolicyDecision = evaluatePolicy(
        constraint.source,
        request.context ?? {},
      );
      if (!decision.allowed) {
        considered.push({
          grantId: grant.grantId,
          namespace: grant.namespace,
          outcome: "constraint_failed",
          detail: decision.reason,
        });
        continue;
      }
    }

    considered.push({
      grantId: grant.grantId,
      namespace: grant.namespace,
      outcome: "used",
    });
    return {
      allowed: true,
      actorDid: request.actorDid,
      namespace: request.namespace,
      grantIdsUsed: [grant.grantId],
      reason:
        constraint === undefined
          ? `grant ${grant.grantId} on ${grant.namespace} covers ${request.namespace}`
          : `grant ${grant.grantId} on ${grant.namespace} covers ${request.namespace}, and its constraint is satisfied`,
      considered,
    };
  }

  return {
    allowed: false,
    actorDid: request.actorDid,
    namespace: request.namespace,
    grantIdsUsed: [],
    reason: explainDenial(request, considered),
    considered,
  };
}

function explainDenial(
  request: AuthorizationRequest,
  considered: readonly ConsideredGrant[],
): string {
  const relevant = considered.filter((c) => c.outcome !== "namespace_mismatch");

  if (relevant.length === 0) {
    return (
      `${request.actorDid} holds no grant covering ${request.namespace}. ` +
      `No ambient authority exists (§6.5), so authority must be granted explicitly.`
    );
  }

  // Name the nearest miss: "you had a grant but its constraint failed" is
  // actionable, "denied" is not.
  const nearest = relevant[0] as ConsideredGrant;
  switch (nearest.outcome) {
    case "revoked":
      return `${request.actorDid}'s grant ${nearest.grantId} on ${nearest.namespace} was revoked`;
    case "expired":
      return `${request.actorDid}'s grant ${nearest.grantId} on ${nearest.namespace} has ${nearest.detail}`;
    case "constraint_failed":
      return `${request.actorDid}'s grant ${nearest.grantId} on ${nearest.namespace} did not apply: ${nearest.detail}`;
    default:
      return `${request.actorDid} is not authorized for ${request.namespace}`;
  }
}

// ---------------------------------------------------------------------------
// Attenuation (§20.5)
// ---------------------------------------------------------------------------

export interface AttenuationRequest {
  readonly parentGrantId: string;
  readonly toDid: string;
  readonly namespace: string;
  readonly constraintSource?: string;
}

export interface AttenuationCheck {
  readonly permitted: boolean;
  readonly reason: string;
}

/**
 * May a grant be re-delegated as described?
 *
 * The check ADR-0010 was chosen to make decidable. Four conditions, each of which
 * has been a real vulnerability class in capability systems:
 *
 *   1. The parent must exist, be live, and be held by the delegator.
 *   2. The parent must be marked redelegable — delegation is opt-in.
 *   3. The child namespace must be within the parent's.
 *   4. The child constraint must be no broader than the parent's. An unconstrained
 *      child of a constrained parent is an escalation, which is the case most
 *      easily missed.
 */
export function checkAttenuation(
  capabilities: CapabilitiesState,
  delegatorDid: string,
  request: AttenuationRequest,
  atLogicalTime: number,
): AttenuationCheck {
  const parent: GrantState | undefined = capabilities.grants.get(request.parentGrantId);

  if (parent === undefined) {
    return { permitted: false, reason: `parent grant ${request.parentGrantId} does not exist` };
  }
  if (parent.toDid !== delegatorDid) {
    return {
      permitted: false,
      reason: `grant ${parent.grantId} is held by ${parent.toDid}, not ${delegatorDid}`,
    };
  }
  if (parent.revoked) {
    return { permitted: false, reason: `parent grant ${parent.grantId} was revoked` };
  }
  if (
    parent.expiresAtLogicalTime !== undefined &&
    parent.expiresAtLogicalTime <= atLogicalTime
  ) {
    return { permitted: false, reason: `parent grant ${parent.grantId} has expired` };
  }
  if (!parent.redelegable) {
    return {
      permitted: false,
      reason: `parent grant ${parent.grantId} is not redelegable`,
    };
  }
  if (!namespaceCovers(parent.namespace, request.namespace)) {
    return {
      permitted: false,
      reason: `namespace ${request.namespace} is not within the parent's ${parent.namespace}`,
    };
  }

  const parentConstraint = parent.constraints?.source;
  const childConstraint = request.constraintSource;

  if (parentConstraint === undefined) {
    // An unconstrained parent may be narrowed however the delegator likes.
    return {
      permitted: true,
      reason: `parent grant ${parent.grantId} is unconstrained, so any constraint narrows it`,
    };
  }

  if (childConstraint === undefined) {
    // The case most easily missed: dropping the constraint widens authority.
    return {
      permitted: false,
      reason:
        `parent grant ${parent.grantId} is constrained, so the child must be too; ` +
        `an unconstrained child would be broader than its parent`,
    };
  }

  const narrowing = narrows(childConstraint, parentConstraint);
  return {
    permitted: narrowing.narrows,
    reason: narrowing.narrows
      ? `child constraint narrows parent grant ${parent.grantId}: ${narrowing.reason}`
      : `child constraint is not narrower than parent grant ${parent.grantId}: ${narrowing.reason}`,
  };
}

// ---------------------------------------------------------------------------
// Multi-party approval (§20.6)
// ---------------------------------------------------------------------------

export interface MultiPartyRequirement {
  readonly namespace: string;
  readonly minimumApprovers: number;
  /** Require approvers from distinct human roots, not merely distinct DIDs. */
  readonly requireDistinctLineages: boolean;
}

export interface MultiPartyCheck {
  readonly satisfied: boolean;
  readonly reason: string;
}

/**
 * Check a multi-party approval requirement.
 *
 * Satisfied by multiple independent signatures rather than threshold
 * cryptography — a deliberate simplification recorded in ADR-0005.
 *
 * `requireDistinctLineages` exists because one operator running several agents
 * would otherwise satisfy a two-of-three rule alone, which is
 * [§59.12](../specification.md): measure lineages, not just identities,
 * or one operator can masquerade as a movement.
 */
export function checkMultiParty(
  requirement: MultiPartyRequirement,
  approvers: readonly { readonly did: string; readonly lineagePseudonym: string }[],
): MultiPartyCheck {
  const distinctDids = new Set(approvers.map((a) => a.did));
  if (distinctDids.size < requirement.minimumApprovers) {
    return {
      satisfied: false,
      reason: `${distinctDids.size} distinct approver(s), ${requirement.minimumApprovers} required`,
    };
  }

  if (requirement.requireDistinctLineages) {
    const lineages = new Set(approvers.map((a) => a.lineagePseudonym));
    if (lineages.size < requirement.minimumApprovers) {
      return {
        satisfied: false,
        reason:
          `${lineages.size} distinct lineage(s) among ${distinctDids.size} approvers, ` +
          `${requirement.minimumApprovers} required; one operator's agents cannot ` +
          `satisfy this alone`,
      };
    }
  }

  return {
    satisfied: true,
    reason: `${distinctDids.size} approver(s) satisfy the requirement`,
  };
}
