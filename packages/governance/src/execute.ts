/**
 * Proposal validation, the genesis constitution, and execution.
 *
 * §6.6: governance affects real system state **only** through structured,
 * validated, authorized actions. This module is the line between this project and
 * a role-play — a proposal that passes here changes what participants can actually
 * do.
 *
 * Execution is transactional (§16.5). Either every action applies or none does. A
 * half-executed proposal would leave the organization in a state nobody voted for.
 *
 * Spec: §15, §16, §17.
 */
import { POLICY_LANGUAGE, validateAttributes } from "@freeq-foundry/policy";
import { hashCanonical, type PolicyExpression } from "@freeq-foundry/protocol";
import {
  KNOWN_NAMESPACES,
  checkAttenuation,
  namespaceCovers,
} from "@freeq-foundry/capabilities";
import type {
  CapabilitiesState,
  ConstitutionRule,
  ConstitutionState,
  GovernanceAction,
  ParticipantsState,
  ProposalOpenedPayload,
  ProposalsState,
} from "@freeq-foundry/projections";
import { QUORUM_VOCABULARY } from "./tally.js";

/** Build a policy expression, hashing the source so amendments are diffable. */
export function policyExpression(source: string): PolicyExpression {
  return {
    language: POLICY_LANGUAGE,
    source,
    sourceHash: hashCanonical(source),
  };
}

// ---------------------------------------------------------------------------
// Genesis constitution (§15, §54)
// ---------------------------------------------------------------------------

/**
 * The minimum needed to bootstrap, and no more (§15.1).
 *
 * Deliberately thin. §5.1 withholds "permanent voting rules beyond the minimum
 * needed to bootstrap" and a complete constitution, because the experiment is
 * about whether agents can build governance — handing them a working one would
 * answer the question by assumption.
 *
 * What is here: a decision procedure, so the first amendment can pass. Nothing
 * about offices, terms, budgets, or process. Those are for the participants.
 */
export function genesisRules(): readonly ConstitutionRule[] {
  return [
    {
      id: "genesis.quorum",
      kind: "quorum",
      description:
        "A proposal passes with a majority of votes cast and at least two distinct human-root lineages voting yes.",
      expression: policyExpression(
        "proposal.yes_share_pct > 50 and proposal.yes_lineages >= 2",
      ),
    },
    {
      id: "genesis.turnout",
      kind: "quorum",
      description: "At least half of eligible participants must vote.",
      expression: policyExpression("proposal.turnout_pct >= 50"),
    },
    {
      id: "genesis.proposal_rights",
      kind: "eligibility",
      description: "Every admitted, unsuspended participant may propose and vote.",
      expression: policyExpression("participant.suspended = 0"),
    },
  ];
}

export const GENESIS_CONSTITUTION = {
  constitutionId: "genesis",
  version: 1,
  rules: genesisRules(),
} as const;

/**
 * Rules participants cannot amend (§15.5, §6.7).
 *
 * The immutable boundary. These are environmental, not organizational: the
 * organization may govern itself but cannot vote away provenance, auditability, or
 * the external evaluator. An amendment touching these fails validation.
 */
export const PROTECTED_RULE_IDS: readonly string[] = [
  "environment.provenance_required",
  "environment.evaluator_external",
  "environment.hash_chain",
  "environment.hard_cost_ceiling",
  "environment.safety_terminal",
];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ProposalValidation {
  readonly valid: boolean;
  readonly problems: readonly string[];
}

/**
 * Validate a proposal before it is opened.
 *
 * Rejecting at proposal time produces a clear error. Rejecting at execution time
 * means participants voted for something that cannot happen, which wastes the
 * scarcest resource in the run — their attention — and corrupts the governance
 * record with decisions that had no effect.
 */
export function validateProposal(
  payload: ProposalOpenedPayload,
  context: {
    readonly constitution: ConstitutionState;
    readonly capabilities: CapabilitiesState;
    readonly participants: ParticipantsState;
    readonly proposals: ProposalsState;
    readonly proposerDid: string;
    readonly atLogicalTime: number;
  },
): ProposalValidation {
  const problems: string[] = [];

  if (payload.actions.length === 0) {
    problems.push("a proposal must contain at least one executable action (§16.4)");
  }
  if (payload.closesAtLogicalTime <= context.atLogicalTime) {
    problems.push(
      `closesAtLogicalTime ${payload.closesAtLogicalTime} is not in the future`,
    );
  }

  const proposer = context.participants.byDid.get(context.proposerDid);
  if (proposer === undefined) {
    problems.push(`proposer ${context.proposerDid} is not an admitted participant`);
  } else if (proposer.suspended) {
    problems.push(`proposer ${context.proposerDid} is suspended`);
  }

  // Dependencies must exist and must not have failed. A proposal contingent on a
  // failed one cannot be executed meaningfully (§16.8).
  for (const dependency of payload.dependsOn ?? []) {
    const other = context.proposals.byId.get(dependency);
    if (other === undefined) {
      problems.push(`depends on unknown proposal ${dependency}`);
    } else if (other.status === "failed" || other.status === "withdrawn") {
      problems.push(`depends on proposal ${dependency}, which ${other.status}`);
    }
  }

  if (payload.constitutionalBasis !== undefined) {
    if (!context.constitution.rules.has(payload.constitutionalBasis)) {
      problems.push(
        `cites constitutional basis ${payload.constitutionalBasis}, which is not a rule in force (§16.6)`,
      );
    }
  }

  for (const [index, action] of payload.actions.entries()) {
    problems.push(
      ...validateAction(action, context, `actions[${index}]`).map((p) => p),
    );
  }

  return { valid: problems.length === 0, problems };
}

function validateAction(
  action: GovernanceAction,
  context: Parameters<typeof validateProposal>[1],
  path: string,
): string[] {
  const problems: string[] = [];

  switch (action.type) {
    case "grant_capability": {
      if (!isKnownNamespace(action.namespace)) {
        problems.push(`${path}: unknown capability namespace ${action.namespace}`);
      }
      if (context.participants.byDid.get(action.toDid) === undefined) {
        problems.push(`${path}: grantee ${action.toDid} is not an admitted participant`);
      }
      if (action.constraints !== undefined) {
        problems.push(
          ...checkExpression(action.constraints, CAPABILITY_VOCABULARY, `${path}.constraints`),
        );
      }
      break;
    }

    case "revoke_capability": {
      if (context.capabilities.grants.get(action.grantId) === undefined) {
        problems.push(`${path}: grant ${action.grantId} does not exist`);
      }
      break;
    }

    case "amend_constitution": {
      for (const ruleId of action.removeRuleIds ?? []) {
        if (PROTECTED_RULE_IDS.includes(ruleId)) {
          // The immutable boundary. Participants may govern themselves but
          // cannot vote away provenance, auditability, or the evaluator (§6.7).
          problems.push(
            `${path}: rule ${ruleId} is environmental and cannot be amended (§15.5)`,
          );
        }
        const existing = context.constitution.rules.get(ruleId);
        if (existing === undefined) {
          problems.push(`${path}: rule ${ruleId} is not in force`);
        } else if (existing.entrenched === true) {
          problems.push(
            `${path}: rule ${ruleId} is entrenched and needs the entrenchment procedure (§17.6)`,
          );
        }
      }
      for (const rule of action.addRules ?? []) {
        if (PROTECTED_RULE_IDS.includes(rule.id)) {
          problems.push(`${path}: rule id ${rule.id} is reserved`);
        }
        if (context.constitution.rules.has(rule.id)) {
          problems.push(`${path}: rule ${rule.id} already exists; amend it instead`);
        }
        problems.push(
          ...checkExpression(
            rule.expression,
            rule.kind === "quorum" ? QUORUM_VOCABULARY : CAPABILITY_VOCABULARY,
            `${path}.rule[${rule.id}]`,
          ),
        );
      }
      break;
    }

    case "create_office": {
      for (const namespace of action.capabilityNamespaces) {
        if (!isKnownNamespace(namespace)) {
          problems.push(`${path}: unknown capability namespace ${namespace}`);
        }
      }
      if (action.termLogicalTime <= 0) {
        problems.push(`${path}: office term must be positive`);
      }
      break;
    }

    case "allocate_budget": {
      if (action.credits <= 0) {
        problems.push(`${path}: allocation must be positive`);
      }
      if (!Number.isSafeInteger(action.credits)) {
        problems.push(`${path}: credits must be an integer (ADR-0004)`);
      }
      break;
    }

    case "assign_work": {
      if (context.participants.byDid.get(action.toDid) === undefined) {
        problems.push(`${path}: assignee ${action.toDid} is not an admitted participant`);
      }
      break;
    }

    case "sanction": {
      if (context.participants.byDid.get(action.targetDid) === undefined) {
        problems.push(`${path}: sanction target ${action.targetDid} is not a participant`);
      }
      break;
    }

    default:
      problems.push(`${path}: unknown action type`);
  }

  return problems;
}

function checkExpression(
  expression: PolicyExpression,
  vocabulary: readonly string[],
  path: string,
): string[] {
  const problems: string[] = [];
  if (expression.language !== POLICY_LANGUAGE) {
    problems.push(
      `${path}: unsupported policy language ${expression.language}, expected ${POLICY_LANGUAGE}`,
    );
    return problems;
  }
  const unknown = validateAttributes(expression.source, vocabulary);
  if (unknown.length > 0) {
    // Caught here rather than at evaluation, where an unknown attribute would
    // deny forever and look like a permissions bug.
    problems.push(
      `${path}: unknown attribute(s) ${unknown.join(", ")}; the vocabulary is fixed (ADR-0010)`,
    );
  }
  return problems;
}

/** Attributes available when a capability constraint is evaluated. */
export const CAPABILITY_VOCABULARY: readonly string[] = [
  "repo.path",
  "repo.branch",
  "deploy.environment",
  "treasury.amount",
  "model.tier",
  "work.item",
  "participant.suspended",
  "run.logical_time",
];

function isKnownNamespace(namespace: string): boolean {
  return KNOWN_NAMESPACES.some(
    (known) => known === namespace || namespaceCovers(known, namespace),
  );
}

// ---------------------------------------------------------------------------
// Execution (§16.5)
// ---------------------------------------------------------------------------

/** An effect to be recorded as an event. Execution decides; the caller records. */
export type Effect =
  | {
      readonly kind: "grant_capability";
      readonly grantId: string;
      readonly toDid: string;
      readonly namespace: string;
      readonly constraints?: PolicyExpression;
      readonly redelegable: boolean;
    }
  | { readonly kind: "revoke_capability"; readonly grantId: string }
  | {
      readonly kind: "adopt_constitution";
      readonly version: number;
      readonly rules: readonly ConstitutionRule[];
    }
  | {
      readonly kind: "create_office";
      readonly officeId: string;
      readonly title: string;
      readonly capabilityNamespaces: readonly string[];
      readonly termLogicalTime: number;
    }
  | { readonly kind: "allocate_budget"; readonly toDid: string; readonly credits: number }
  | { readonly kind: "assign_work"; readonly workItemId: string; readonly toDid: string }
  | { readonly kind: "sanction"; readonly targetDid: string; readonly reasonCode: string };

export interface ExecutionResult {
  readonly executed: boolean;
  readonly effects: readonly Effect[];
  readonly reason: string;
}

/**
 * Execute a passed proposal's actions.
 *
 * Transactional: revalidates first and produces effects only if **every** action
 * is still applicable. State can change between passage and execution — a grant
 * cited in the proposal may have been revoked, a grantee suspended — so passage is
 * not a licence to skip checks.
 *
 * Returns effects rather than appending events, which keeps this pure and lets the
 * caller record them atomically.
 */
export function executeProposal(
  payload: ProposalOpenedPayload,
  context: {
    readonly constitution: ConstitutionState;
    readonly capabilities: CapabilitiesState;
    readonly participants: ParticipantsState;
    readonly proposals: ProposalsState;
    readonly proposerDid: string;
    readonly atLogicalTime: number;
  },
): ExecutionResult {
  // Revalidate. Passage authorized the intent, not a stale plan.
  const revalidation = validateProposal(
    { ...payload, closesAtLogicalTime: context.atLogicalTime + 1 },
    context,
  );
  if (!revalidation.valid) {
    return {
      executed: false,
      effects: [],
      reason: `execution aborted: ${revalidation.problems.join("; ")}`,
    };
  }

  const effects: Effect[] = [];
  let constitutionVersion = context.constitution.version;
  let workingRules = new Map(context.constitution.rules);

  for (const [index, action] of payload.actions.entries()) {
    switch (action.type) {
      case "grant_capability":
        effects.push({
          kind: "grant_capability",
          grantId: `${payload.proposalId}-grant-${index}`,
          toDid: action.toDid,
          namespace: action.namespace,
          ...(action.constraints === undefined ? {} : { constraints: action.constraints }),
          redelegable: action.redelegable ?? false,
        });
        break;

      case "revoke_capability":
        effects.push({ kind: "revoke_capability", grantId: action.grantId });
        break;

      case "amend_constitution": {
        for (const ruleId of action.removeRuleIds ?? []) workingRules.delete(ruleId);
        for (const rule of action.addRules ?? []) workingRules.set(rule.id, rule);
        constitutionVersion++;
        effects.push({
          kind: "adopt_constitution",
          version: constitutionVersion,
          rules: [...workingRules.values()],
        });
        break;
      }

      case "create_office":
        effects.push({
          kind: "create_office",
          officeId: action.officeId,
          title: action.title,
          capabilityNamespaces: action.capabilityNamespaces,
          termLogicalTime: action.termLogicalTime,
        });
        break;

      case "allocate_budget":
        effects.push({
          kind: "allocate_budget",
          toDid: action.toDid,
          credits: action.credits,
        });
        break;

      case "assign_work":
        effects.push({
          kind: "assign_work",
          workItemId: action.workItemId,
          toDid: action.toDid,
        });
        break;

      case "sanction":
        effects.push({
          kind: "sanction",
          targetDid: action.targetDid,
          reasonCode: action.reasonCode,
        });
        break;

      default:
        // Unreachable given validation, but an unknown action must never be
        // silently skipped: that would execute a proposal partially.
        return {
          executed: false,
          effects: [],
          reason: `execution aborted: unknown action at index ${index}`,
        };
    }
  }

  return {
    executed: true,
    effects,
    reason: `applied ${effects.length} effect(s) from ${payload.actions.length} action(s)`,
  };
}

/**
 * Check a delegation is a valid attenuation before recording it.
 *
 * Thin wrapper over the capabilities check, present so governance never re-derives
 * narrowing logic. One implementation of a security check is safer than two that
 * agree today.
 */
export function validateDelegation(
  capabilities: CapabilitiesState,
  delegatorDid: string,
  request: Parameters<typeof checkAttenuation>[2],
  atLogicalTime: number,
): ReturnType<typeof checkAttenuation> {
  return checkAttenuation(capabilities, delegatorDid, request, atLogicalTime);
}
