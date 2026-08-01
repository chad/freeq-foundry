/**
 * Core projections (§34.2).
 *
 * Each is a pure fold. Where a projection could plausibly infer something, it
 * does not: a projection that guesses is a projection that disagrees with the log
 * in a way nobody notices.
 *
 * Spec: §34.2, §40.
 */
import {
  RunTerminationReason,
  RunValidity,
  runClockMs,
  type ClockPause,
  type RecordedEvent,
} from "@freeq-foundry/protocol";
import {
  EventTypes,
  categoryOf,
  type AuthorizationDecidedPayload,
  type CapabilityGrantedPayload,
  type ConstitutionAdoptedPayload,
  type ConstitutionRule,
  type NominationPayload,
  type OfficeAssignedPayload,
  type OfficeCreatedPayload,
  type OfficeVacatedPayload,
  type ParticipantAdmittedPayload,
  type ParticipantSuspendedPayload,
  type ProposalClosedPayload,
  type ProposalOpenedPayload,
  type ReleaseVerifiedPayload,
  type RunStartedPayload,
  type RunTerminatedPayload,
  type SafetyEventPayload,
  type SpendRecordedPayload,
  type ValidityJudgedPayload,
  type VoteCastPayload,
} from "./events.js";
import type { Projector } from "./projector.js";

const payloadOf = <T>(event: RecordedEvent): T => event.payload as T;

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface RunState {
  readonly runId?: string;
  readonly scenarioId?: string;
  readonly started: boolean;
  readonly genesisWallTimeMs?: number;
  readonly horizonMs?: number;
  readonly evaluatorDid?: string;
  readonly confirmatory: boolean;
  readonly manifestHash?: string;
  readonly pauses: readonly ClockPause[];
  readonly validity: RunValidity;
  /** Logical time of the validity judgement, for the blindness check (ADR-0009). */
  readonly validityJudgedAtLogicalTime?: number;
  /** Logical time of the first evaluation event, likewise. */
  readonly firstEvaluationLogicalTime?: number;
  readonly terminated: boolean;
  readonly terminationReason?: RunTerminationReason;
  /** Run-clock ms to the first verified release, absent if never shipped. */
  readonly timeToReleaseMs?: number;
  readonly lastWallTimeMs?: number;
  readonly lastLogicalTime: number;
}

export const runProjector: Projector<RunState> = {
  id: "run",
  version: 1,
  initialState: () => ({
    started: false,
    confirmatory: false,
    pauses: [],
    validity: RunValidity.VALID,
    terminated: false,
    lastLogicalTime: -1,
  }),
  apply(state, event) {
    const wallTimeMs = Date.parse(event.wallTime);

    // The first evaluation event is recorded so a validity judgement made after
    // evaluation began can be detected as non-blind, rather than taken on trust
    // (ADR-0009).
    const firstEvaluation =
      state.firstEvaluationLogicalTime ??
      (categoryOf(event.eventType) === "evaluation" ? event.logicalTime : undefined);

    const next: RunState = {
      ...state,
      ...(firstEvaluation === undefined
        ? {}
        : { firstEvaluationLogicalTime: firstEvaluation }),
      lastWallTimeMs: wallTimeMs,
      lastLogicalTime: event.logicalTime,
    };

    switch (event.eventType) {
      case EventTypes.RUN_STARTED: {
        const payload = payloadOf<RunStartedPayload>(event);
        return {
          ...next,
          runId: event.runId,
          scenarioId: payload.scenarioId,
          started: true,
          genesisWallTimeMs: wallTimeMs,
          horizonMs: payload.horizonMs,
          evaluatorDid: payload.evaluatorDid,
          confirmatory: payload.confirmatory,
          manifestHash: payload.manifestHash,
        };
      }

      case EventTypes.RUN_CLOCK_PAUSED:
        return { ...next, pauses: [...state.pauses, { pausedAtMs: wallTimeMs }] };

      case EventTypes.RUN_CLOCK_RESUMED: {
        const open = state.pauses.findIndex((p) => p.resumedAtMs === undefined);
        if (open === -1) return next; // Resume without pause: ignore, do not invent.
        const pauses = [...state.pauses];
        pauses[open] = { ...(pauses[open] as ClockPause), resumedAtMs: wallTimeMs };
        return { ...next, pauses };
      }

      case EventTypes.RUN_VALIDITY_JUDGED: {
        const payload = payloadOf<ValidityJudgedPayload>(event);
        return {
          ...next,
          validity: payload.validity,
          validityJudgedAtLogicalTime: event.logicalTime,
        };
      }

      case EventTypes.RELEASE_VERIFIED: {
        if (state.timeToReleaseMs !== undefined) return next; // First release only.
        const genesis = state.genesisWallTimeMs;
        if (genesis === undefined) return next;
        return {
          ...next,
          timeToReleaseMs: runClockMs(genesis, wallTimeMs, state.pauses),
        };
      }

      case EventTypes.RUN_TERMINATED: {
        const payload = payloadOf<RunTerminatedPayload>(event);
        return { ...next, terminated: true, terminationReason: payload.reason };
      }

      default:
        return next;
    }
  },
};

/** Elapsed run time at the projection's current position. */
export function elapsedRunClockMs(state: RunState): number {
  if (state.genesisWallTimeMs === undefined || state.lastWallTimeMs === undefined) {
    return 0;
  }
  return runClockMs(state.genesisWallTimeMs, state.lastWallTimeMs, state.pauses);
}

// ---------------------------------------------------------------------------
// Participants and lineage
// ---------------------------------------------------------------------------

export interface ParticipantState {
  readonly did: string;
  readonly participantType: string;
  readonly admissionCredentialId: string;
  readonly terminalHumanDids: readonly string[];
  readonly lineageDepth: number;
  readonly lineagePseudonym: string;
  readonly declaredAutonomy: "autonomous" | "supervised" | "teleoperated" | "undeclared";
  readonly suspended: boolean;
  readonly admittedAtLogicalTime: number;
  readonly actionCount: number;
  /** Actions preceded by a signed human instruction, per §58.5. */
  readonly instructedActionCount: number;
}

export interface ParticipantsState {
  readonly byDid: ReadonlyMap<string, ParticipantState>;
}

export const participantsProjector: Projector<ParticipantsState> = {
  id: "participants",
  version: 1,
  initialState: () => ({ byDid: new Map() }),
  apply(state, event) {
    const byDid = new Map(state.byDid);

    if (event.eventType === EventTypes.PARTICIPANT_ADMITTED) {
      const payload = payloadOf<ParticipantAdmittedPayload>(event);
      byDid.set(payload.did, {
        did: payload.did,
        participantType: payload.participantType,
        admissionCredentialId: payload.admissionCredentialId,
        terminalHumanDids: payload.terminalHumanDids,
        lineageDepth: payload.lineageDepth,
        lineagePseudonym: payload.lineagePseudonym,
        declaredAutonomy: payload.declaredAutonomy ?? "undeclared",
        suspended: false,
        admittedAtLogicalTime: event.logicalTime,
        actionCount: 0,
        instructedActionCount: 0,
      });
      return { byDid };
    }

    if (
      event.eventType === EventTypes.PARTICIPANT_SUSPENDED ||
      event.eventType === EventTypes.PARTICIPANT_REINSTATED
    ) {
      const payload = payloadOf<ParticipantSuspendedPayload>(event);
      const existing = byDid.get(payload.did);
      if (existing === undefined) return state;
      byDid.set(payload.did, {
        ...existing,
        suspended: event.eventType === EventTypes.PARTICIPANT_SUSPENDED,
      });
      return { byDid };
    }

    // Count activity for every actor, so autonomy can be measured rather than
    // taken from a self-declaration (§58.5).
    const actor = byDid.get(event.actorDid);
    if (actor !== undefined) {
      byDid.set(event.actorDid, {
        ...actor,
        actionCount: actor.actionCount + 1,
        instructedActionCount:
          actor.instructedActionCount +
          (event.provenance.directInstructionEventIds.length > 0 ? 1 : 0),
      });
      return { byDid };
    }

    return state;
  },
};

/** Distinct terminal human roots among active participants (§40.5). */
export function distinctLineages(state: ParticipantsState): number {
  const roots = new Set<string>();
  for (const participant of state.byDid.values()) {
    if (participant.suspended) continue;
    for (const root of participant.terminalHumanDids) roots.add(root);
  }
  return roots.size;
}

/**
 * Observed autonomy: the share of a participant's actions that followed a signed
 * instruction.
 *
 * Self-declaration is a claim; this is evidence. §58.5 requires reporting both
 * and flagging disagreement, because a teleoperated agent counted as autonomous
 * corrupts every claim about model behaviour.
 */
export function autonomyDisagreements(
  state: ParticipantsState,
  supervisedThreshold = 0.5,
): readonly { did: string; declared: string; instructedShare: number }[] {
  const out: { did: string; declared: string; instructedShare: number }[] = [];
  for (const participant of state.byDid.values()) {
    if (participant.actionCount === 0) continue;
    const share = participant.instructedActionCount / participant.actionCount;
    const looksSupervised = share >= supervisedThreshold;
    const declaredAutonomous = participant.declaredAutonomy === "autonomous";
    if (looksSupervised && declaredAutonomous) {
      out.push({
        did: participant.did,
        declared: participant.declaredAutonomy,
        instructedShare: share,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Constitution
// ---------------------------------------------------------------------------

export interface ConstitutionState {
  readonly constitutionId?: string;
  readonly version: number;
  readonly rules: ReadonlyMap<string, ConstitutionRule>;
  readonly amendmentCount: number;
  readonly adoptedAtLogicalTime?: number;
}

export const constitutionProjector: Projector<ConstitutionState> = {
  id: "constitution",
  version: 1,
  initialState: () => ({ version: 0, rules: new Map(), amendmentCount: 0 }),
  apply(state, event) {
    if (event.eventType === EventTypes.CONSTITUTION_ADOPTED) {
      const payload = payloadOf<ConstitutionAdoptedPayload>(event);
      return {
        constitutionId: payload.constitutionId,
        version: payload.version,
        rules: new Map(payload.rules.map((rule) => [rule.id, rule])),
        amendmentCount: state.amendmentCount + (state.version === 0 ? 0 : 1),
        adoptedAtLogicalTime: event.logicalTime,
      };
    }
    return state;
  },
};

/** Rules in force at a logical time, excluding those that have sunset (§17.7). */
export function activeRules(
  state: ConstitutionState,
  atLogicalTime: number,
): readonly ConstitutionRule[] {
  return [...state.rules.values()].filter(
    (rule) =>
      rule.sunsetAtLogicalTime === undefined ||
      rule.sunsetAtLogicalTime > atLogicalTime,
  );
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export interface ProposalState {
  readonly proposalId: string;
  readonly kind: string;
  readonly title: string;
  readonly proposerDid: string;
  readonly actions: ProposalOpenedPayload["actions"];
  readonly constitutionalBasis?: string;
  readonly closesAtLogicalTime: number;
  readonly openedAtLogicalTime: number;
  readonly status: "open" | "passed" | "failed" | "executed" | "execution_failed" | "withdrawn";
  readonly votes: ReadonlyMap<string, VoteCastPayload>;
  readonly tally?: ProposalClosedPayload["tally"];
  readonly closeReason?: string;
}

export interface ProposalsState {
  readonly byId: ReadonlyMap<string, ProposalState>;
}

export const proposalsProjector: Projector<ProposalsState> = {
  id: "proposals",
  version: 1,
  initialState: () => ({ byId: new Map() }),
  apply(state, event) {
    const byId = new Map(state.byId);

    switch (event.eventType) {
      case EventTypes.PROPOSAL_OPENED: {
        const payload = payloadOf<ProposalOpenedPayload>(event);
        byId.set(payload.proposalId, {
          proposalId: payload.proposalId,
          kind: payload.kind,
          title: payload.title,
          proposerDid: event.actorDid,
          actions: payload.actions,
          ...(payload.constitutionalBasis === undefined
            ? {}
            : { constitutionalBasis: payload.constitutionalBasis }),
          closesAtLogicalTime: payload.closesAtLogicalTime,
          openedAtLogicalTime: event.logicalTime,
          status: "open",
          votes: new Map(),
        });
        return { byId };
      }

      case EventTypes.VOTE_CAST: {
        const payload = payloadOf<VoteCastPayload>(event);
        const proposal = byId.get(payload.proposalId);
        if (proposal === undefined || proposal.status !== "open") return state;
        const votes = new Map(proposal.votes);
        // Last vote wins, which is how vote-changing works. The earlier vote
        // remains in the log, so the change is visible.
        votes.set(event.actorDid, payload);
        byId.set(payload.proposalId, { ...proposal, votes });
        return { byId };
      }

      case EventTypes.PROPOSAL_CLOSED: {
        const payload = payloadOf<ProposalClosedPayload>(event);
        const proposal = byId.get(payload.proposalId);
        if (proposal === undefined) return state;
        byId.set(payload.proposalId, {
          ...proposal,
          status: payload.outcome,
          tally: payload.tally,
          closeReason: payload.reason,
        });
        return { byId };
      }

      case EventTypes.PROPOSAL_EXECUTED:
      case EventTypes.PROPOSAL_EXECUTION_FAILED: {
        const payload = event.payload as { proposalId: string };
        const proposal = byId.get(payload.proposalId);
        if (proposal === undefined) return state;
        byId.set(payload.proposalId, {
          ...proposal,
          status:
            event.eventType === EventTypes.PROPOSAL_EXECUTED
              ? "executed"
              : "execution_failed",
        });
        return { byId };
      }

      case EventTypes.PROPOSAL_WITHDRAWN: {
        const payload = event.payload as { proposalId: string };
        const proposal = byId.get(payload.proposalId);
        if (proposal === undefined) return state;
        byId.set(payload.proposalId, { ...proposal, status: "withdrawn" });
        return { byId };
      }

      default:
        return state;
    }
  },
};

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export interface GrantState {
  readonly grantId: string;
  readonly toDid: string;
  readonly namespace: string;
  readonly constraints?: CapabilityGrantedPayload["constraints"];
  readonly redelegable: boolean;
  readonly parentGrantId?: string;
  readonly grantedByProposalId?: string;
  readonly grantedAtLogicalTime: number;
  readonly expiresAtLogicalTime?: number;
  readonly revoked: boolean;
}

export interface CapabilitiesState {
  readonly grants: ReadonlyMap<string, GrantState>;
  readonly deniedActions: number;
  readonly authorizationDecisions: number;
}

export const capabilitiesProjector: Projector<CapabilitiesState> = {
  id: "capabilities",
  version: 1,
  initialState: () => ({
    grants: new Map(),
    deniedActions: 0,
    authorizationDecisions: 0,
  }),
  apply(state, event) {
    switch (event.eventType) {
      case EventTypes.CAPABILITY_GRANTED:
      case EventTypes.CAPABILITY_ATTENUATED: {
        const payload = payloadOf<CapabilityGrantedPayload>(event);
        const grants = new Map(state.grants);
        grants.set(payload.grantId, {
          grantId: payload.grantId,
          toDid: payload.toDid,
          namespace: payload.namespace,
          ...(payload.constraints === undefined
            ? {}
            : { constraints: payload.constraints }),
          redelegable: payload.redelegable,
          ...(payload.parentGrantId === undefined
            ? {}
            : { parentGrantId: payload.parentGrantId }),
          ...(payload.grantedByProposalId === undefined
            ? {}
            : { grantedByProposalId: payload.grantedByProposalId }),
          grantedAtLogicalTime: event.logicalTime,
          ...(payload.expiresAtLogicalTime === undefined
            ? {}
            : { expiresAtLogicalTime: payload.expiresAtLogicalTime }),
          revoked: false,
        });
        return { ...state, grants };
      }

      case EventTypes.CAPABILITY_REVOKED: {
        const payload = event.payload as { grantId: string };
        const grants = new Map(state.grants);
        const existing = grants.get(payload.grantId);
        if (existing === undefined) return state;
        grants.set(payload.grantId, { ...existing, revoked: true });
        // Revoking a parent revokes everything attenuated from it: an
        // attenuated grant cannot outlive the authority it narrowed (§20.5).
        for (const [id, grant] of grants) {
          if (isDescendantOf(grants, grant, payload.grantId)) {
            grants.set(id, { ...grant, revoked: true });
          }
        }
        return { ...state, grants };
      }

      case EventTypes.AUTHORIZATION_DECIDED:
        return {
          ...state,
          authorizationDecisions: state.authorizationDecisions + 1,
        };

      case EventTypes.ACTION_DENIED:
        return { ...state, deniedActions: state.deniedActions + 1 };

      default:
        return state;
    }
  },
};

function isDescendantOf(
  grants: ReadonlyMap<string, GrantState>,
  grant: GrantState,
  ancestorId: string,
): boolean {
  let current = grant.parentGrantId;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = grants.get(current)?.parentGrantId;
  }
  return false;
}

/** Live grants for a participant at a logical time. */
export function activeGrantsFor(
  state: CapabilitiesState,
  did: string,
  atLogicalTime: number,
): readonly GrantState[] {
  return [...state.grants.values()].filter(
    (grant) =>
      grant.toDid === did &&
      !grant.revoked &&
      (grant.expiresAtLogicalTime === undefined ||
        grant.expiresAtLogicalTime > atLogicalTime),
  );
}

/** Share of live grants held by the largest lineage (§40.4). */
export function authorityConcentration(
  capabilities: CapabilitiesState,
  participants: ParticipantsState,
  atLogicalTime: number,
): number {
  const byLineage = new Map<string, number>();
  let total = 0;

  for (const grant of capabilities.grants.values()) {
    if (grant.revoked) continue;
    if (
      grant.expiresAtLogicalTime !== undefined &&
      grant.expiresAtLogicalTime <= atLogicalTime
    ) {
      continue;
    }
    total++;
    const holder = participants.byDid.get(grant.toDid);
    const key = holder?.lineagePseudonym ?? "unknown";
    byLineage.set(key, (byLineage.get(key) ?? 0) + 1);
  }

  if (total === 0) return 0;
  return Math.max(...byLineage.values()) / total;
}

// ---------------------------------------------------------------------------
// Offices (§18)
// ---------------------------------------------------------------------------

export interface OfficeTermState {
  readonly holderDid: string;
  readonly startedAtLogicalTime: number;
  readonly expiresAtLogicalTime: number;
  readonly grantIds: readonly string[];
  readonly endedAtLogicalTime?: number;
  readonly endReason?: string;
}

export interface OfficeRecord {
  readonly officeId: string;
  readonly title: string;
  readonly capabilityNamespaces: readonly string[];
  readonly termLogicalTime: number;
  readonly electionMethod: string;
  readonly tieBreaks: readonly string[];
  readonly exclusive: boolean;
  readonly removalThresholdPct: number;
  readonly current?: OfficeTermState;
  readonly history: readonly OfficeTermState[];
  readonly nominations: readonly { readonly candidateId: string; readonly candidateDid: string; readonly atLogicalTime: number }[];
}

export interface OfficesState {
  readonly byId: ReadonlyMap<string, OfficeRecord>;
  /** Completed terms, for leadership-turnover analysis (§40.2). */
  readonly completedTerms: number;
}

export const officesProjector: Projector<OfficesState> = {
  id: "offices",
  version: 1,
  initialState: () => ({ byId: new Map(), completedTerms: 0 }),
  apply(state, event) {
    switch (event.eventType) {
      case EventTypes.OFFICE_CREATED: {
        const payload = payloadOf<OfficeCreatedPayload>(event);
        const byId = new Map(state.byId);
        byId.set(payload.officeId, {
          officeId: payload.officeId,
          title: payload.title,
          capabilityNamespaces: payload.capabilityNamespaces,
          termLogicalTime: payload.termLogicalTime,
          electionMethod: payload.electionMethod,
          tieBreaks: payload.tieBreaks,
          exclusive: payload.exclusive ?? false,
          removalThresholdPct: payload.removalThresholdPct ?? 50,
          history: [],
          nominations: [],
        });
        return { ...state, byId };
      }

      case EventTypes.NOMINATION_MADE: {
        const payload = payloadOf<NominationPayload>(event);
        const office = state.byId.get(payload.officeId);
        if (office === undefined) return state;
        const byId = new Map(state.byId);
        byId.set(payload.officeId, {
          ...office,
          nominations: [
            // A repeat nomination does not create a second candidate.
            ...office.nominations.filter((n) => n.candidateId !== payload.candidateId),
            {
              candidateId: payload.candidateId,
              candidateDid: payload.candidateDid,
              atLogicalTime: event.logicalTime,
            },
          ],
        });
        return { ...state, byId };
      }

      case EventTypes.OFFICE_ASSIGNED: {
        const payload = payloadOf<OfficeAssignedPayload>(event);
        const office = state.byId.get(payload.officeId);
        if (office === undefined) return state;
        const byId = new Map(state.byId);
        byId.set(payload.officeId, {
          ...office,
          current: {
            holderDid: payload.holderDid,
            startedAtLogicalTime: event.logicalTime,
            expiresAtLogicalTime: payload.expiresAtLogicalTime,
            grantIds: payload.grantIds,
          },
          // Nominations are cleared on assignment: a stale candidate list would let a
          // later election reuse nominations nobody restated.
          nominations: [],
        });
        return { ...state, byId };
      }

      case EventTypes.OFFICE_VACATED: {
        const payload = payloadOf<OfficeVacatedPayload>(event);
        const office = state.byId.get(payload.officeId);
        if (office === undefined || office.current === undefined) return state;
        const byId = new Map(state.byId);
        const ended: OfficeTermState = {
          ...office.current,
          endedAtLogicalTime: event.logicalTime,
          endReason: payload.reason,
        };
        const { current: _dropped, ...rest } = office;
        byId.set(payload.officeId, {
          ...rest,
          history: [...office.history, ended],
          nominations: [],
        });
        return { byId, completedTerms: state.completedTerms + 1 };
      }

      default:
        return state;
    }
  },
};

/** Offices a participant currently holds. */
export function officesHeld(state: OfficesState, did: string): readonly string[] {
  return [...state.byId.values()]
    .filter((office) => office.current?.holderDid === did)
    .map((office) => office.officeId);
}

/**
 * Leadership turnover: completed terms per office created (§40.2).
 *
 * High turnover is not automatically bad — an organization that recalls an
 * underperforming holder is working. Reported, not optimized against.
 */
export function leadershipTurnover(state: OfficesState): number {
  return state.byId.size === 0 ? 0 : state.completedTerms / state.byId.size;
}

// ---------------------------------------------------------------------------
// Treasury
// ---------------------------------------------------------------------------

export interface TreasuryState {
  readonly creditsByAccount: ReadonlyMap<string, number>;
  readonly spentByAccount: ReadonlyMap<string, number>;
  readonly spentByPurpose: ReadonlyMap<string, number>;
  readonly usdSpentMicros: number;
  readonly exhausted: boolean;
}

export const treasuryProjector: Projector<TreasuryState> = {
  id: "treasury",
  version: 1,
  initialState: () => ({
    creditsByAccount: new Map(),
    spentByAccount: new Map(),
    spentByPurpose: new Map(),
    usdSpentMicros: 0,
    exhausted: false,
  }),
  apply(state, event) {
    switch (event.eventType) {
      case EventTypes.BUDGET_ALLOCATED: {
        const payload = event.payload as { toDid: string; credits: number };
        const creditsByAccount = new Map(state.creditsByAccount);
        creditsByAccount.set(
          payload.toDid,
          (creditsByAccount.get(payload.toDid) ?? 0) + payload.credits,
        );
        return { ...state, creditsByAccount };
      }

      case EventTypes.SPEND_RECORDED: {
        const payload = payloadOf<SpendRecordedPayload>(event);
        const spentByAccount = new Map(state.spentByAccount);
        spentByAccount.set(
          payload.account,
          (spentByAccount.get(payload.account) ?? 0) + payload.credits,
        );
        const spentByPurpose = new Map(state.spentByPurpose);
        spentByPurpose.set(
          payload.purpose,
          (spentByPurpose.get(payload.purpose) ?? 0) + payload.credits,
        );
        return {
          ...state,
          spentByAccount,
          spentByPurpose,
          // Integer micros, because ADR-0004 forbids floats and accumulating
          // money in binary floating point drifts.
          usdSpentMicros: state.usdSpentMicros + usdToMicros(payload.usd),
        };
      }

      case EventTypes.BUDGET_EXHAUSTED:
        return { ...state, exhausted: true };

      default:
        return state;
    }
  },
};

function usdToMicros(usd: string | undefined): number {
  if (usd === undefined) return 0;
  const [whole = "0", fraction = ""] = usd.split(".");
  const micros = `${fraction}000000`.slice(0, 6);
  const sign = whole.startsWith("-") ? -1 : 1;
  return sign * (Math.abs(Number(whole)) * 1_000_000 + Number(micros));
}

/** Governance spend as a share of total (§40.3). Returns 0 when nothing was spent. */
export function governanceCostShare(state: TreasuryState): number {
  let total = 0;
  for (const amount of state.spentByPurpose.values()) total += amount;
  if (total === 0) return 0;
  return (state.spentByPurpose.get("governance") ?? 0) / total;
}

export function remainingCredits(state: TreasuryState, account: string): number {
  return (
    (state.creditsByAccount.get(account) ?? 0) -
    (state.spentByAccount.get(account) ?? 0)
  );
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export interface OutcomeState {
  readonly shipped: boolean;
  readonly releaseId?: string;
  readonly acceptanceFraction: string;
  readonly mandatoryTestsPassed: number;
  readonly mandatoryTestsTotal: number;
  readonly severeSafetyEvents: number;
  readonly releaseAttempts: number;
}

export const outcomeProjector: Projector<OutcomeState> = {
  id: "outcome",
  version: 1,
  initialState: () => ({
    shipped: false,
    acceptanceFraction: "0",
    mandatoryTestsPassed: 0,
    mandatoryTestsTotal: 0,
    severeSafetyEvents: 0,
    releaseAttempts: 0,
  }),
  apply(state, event) {
    switch (event.eventType) {
      case EventTypes.RELEASE_SUBMITTED:
        return { ...state, releaseAttempts: state.releaseAttempts + 1 };

      case EventTypes.RELEASE_VERIFIED: {
        const payload = payloadOf<ReleaseVerifiedPayload>(event);
        if (state.shipped) return state;
        return {
          ...state,
          shipped: true,
          releaseId: payload.releaseId,
          acceptanceFraction: payload.acceptanceFraction,
          mandatoryTestsPassed: payload.mandatoryTestsPassed,
          mandatoryTestsTotal: payload.mandatoryTestsTotal,
        };
      }

      case EventTypes.RELEASE_REJECTED: {
        // Partial progress still counts as progress, but only the best attempt.
        const payload = event.payload as {
          acceptanceFraction: string;
          mandatoryTestsPassed: number;
          mandatoryTestsTotal: number;
        };
        if (state.shipped) return state;
        if (Number(payload.acceptanceFraction) <= Number(state.acceptanceFraction)) {
          return state;
        }
        return {
          ...state,
          acceptanceFraction: payload.acceptanceFraction,
          mandatoryTestsPassed: payload.mandatoryTestsPassed,
          mandatoryTestsTotal: payload.mandatoryTestsTotal,
        };
      }

      case EventTypes.SAFETY_EVENT: {
        const payload = payloadOf<SafetyEventPayload>(event);
        const severe = payload.severity === "severe" || payload.severity === "terminal";
        return {
          ...state,
          severeSafetyEvents: state.severeSafetyEvents + (severe ? 1 : 0),
        };
      }

      default:
        return state;
    }
  },
};

// ---------------------------------------------------------------------------
// Activity, for governance overhead (§40.3)
// ---------------------------------------------------------------------------

export interface ActivityState {
  readonly byCategory: ReadonlyMap<string, number>;
  readonly total: number;
}

export const activityProjector: Projector<ActivityState> = {
  id: "activity",
  version: 1,
  initialState: () => ({ byCategory: new Map(), total: 0 }),
  apply(state, event) {
    const category = categoryOf(event.eventType);
    const byCategory = new Map(state.byCategory);
    byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
    return { byCategory, total: state.total + 1 };
  },
};

/**
 * Governance events per consequential production event (§40.3).
 *
 * "Governance overhead is not inherently bad" — §40.3 is explicit about this. The
 * metric is reported, never optimized against.
 */
export function governanceOverhead(state: ActivityState): number {
  const governance =
    (state.byCategory.get("governance") ?? 0) +
    (state.byCategory.get("election") ?? 0) +
    (state.byCategory.get("delegation") ?? 0);
  const production =
    (state.byCategory.get("repository") ?? 0) +
    (state.byCategory.get("work") ?? 0) +
    (state.byCategory.get("ci") ?? 0) +
    (state.byCategory.get("deployment") ?? 0);
  if (production === 0) return governance === 0 ? 0 : Number.POSITIVE_INFINITY;
  return governance / production;
}

/** Every core projector (§34.2). */
export const coreProjectors = [
  runProjector,
  participantsProjector,
  constitutionProjector,
  proposalsProjector,
  officesProjector,
  capabilitiesProjector,
  treasuryProjector,
  outcomeProjector,
  activityProjector,
] as const;
