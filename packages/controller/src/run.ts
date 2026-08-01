/**
 * The experiment controller: a run from genesis to termination.
 *
 * This is where every other package meets. The loop is deliberately simple —
 * activate agents in a fair order, authorize what they ask for, append the
 * resulting events, reproject, repeat — because the interesting behaviour should
 * come from the participants and the rules, not from the orchestrator.
 *
 * Everything the controller does is an event. Nothing is held in memory that
 * cannot be rebuilt from the log, which is what makes §6.9 replay true rather
 * than aspirational.
 *
 * Spec: §8.9, §9.7, §27, §47, §57.
 */
import {
  DEFAULT_HORIZON_MS,
  RunTerminationReason,
  RunValidity,
  hashCanonical,
  type KeyPair,
  type RunManifest,
} from "@freeq-foundry/protocol";
import { InMemoryEventStore } from "@freeq-foundry/event-store";
import { Gateway, StaticAdmissionRegistry } from "@freeq-foundry/gateway";
import {
  EventTypes,
  activityProjector,
  capabilitiesProjector,
  constitutionProjector,
  coreProjectors,
  elapsedRunClockMs,
  outcomeProjector,
  participantsProjector,
  projectAll,
  proposalsProjector,
  runProjector,
  treasuryProjector,
  type ActivityState,
  type CapabilitiesState,
  type ConstitutionState,
  type OutcomeState,
  type ParticipantsState,
  type ProposalsState,
  type RunState,
  type TreasuryState,
} from "@freeq-foundry/projections";
import { authorize, checkAttenuation } from "@freeq-foundry/capabilities";
import {
  evaluateQuorum,
  executeProposal,
  genesisRules,
  tallyProposal,
  validateProposal,
} from "@freeq-foundry/governance";
import { invocationCost, type ActionRequest, type AgentAdapter, type AgentView } from "@freeq-foundry/agents";
import { EventWriter } from "./writer.js";

export interface WorkItem {
  readonly workItemId: string;
  readonly mandatory: boolean;
}

export interface Scenario {
  readonly scenarioId: string;
  readonly workItems: readonly WorkItem[];
  /** Credits allocated to each participant at genesis (§21.4). */
  readonly genesisCreditsPerParticipant: number;
  /** Hard tick ceiling. A run that cannot end is a run that cannot be analyzed. */
  readonly maxTicks: number;
  readonly horizonMs?: number;
  /** Simulated milliseconds per tick, so the run clock advances deterministically. */
  readonly msPerTick?: number;
}

export interface ParticipantSpec {
  readonly keyPair: KeyPair;
  readonly adapter: AgentAdapter;
  readonly lineagePseudonym: string;
  readonly terminalHumanDid: string;
  readonly declaredAutonomy?: "autonomous" | "supervised" | "teleoperated";
}

export interface RunConfig {
  readonly runId: string;
  readonly scenario: Scenario;
  readonly participants: readonly ParticipantSpec[];
  readonly recorder: KeyPair;
  readonly controller: KeyPair;
  readonly evaluator: KeyPair;
  readonly confirmatory?: boolean;
  /** Condition label, e.g. `capability_enforced` or `unenforced_governance`. */
  readonly arm?: string;
  /**
   * When false, capability checks are bypassed — §49.6 Condition F.
   *
   * This is the platform's central claim under test: whether executable
   * capability enforcement matters. Denials are still recorded, so the two arms
   * produce comparable records.
   */
  readonly enforceCapabilities?: boolean;
}

export interface RunResult {
  readonly runId: string;
  readonly ticks: number;
  readonly terminationReason: RunTerminationReason;
  readonly validity: RunValidity;
  readonly shipped: boolean;
  readonly timeToReleaseMs?: number;
  readonly horizonMs: number;
  readonly eventCount: number;
  readonly manifest: RunManifest;
  readonly store: InMemoryEventStore;
  readonly state: {
    readonly run: RunState;
    readonly participants: ParticipantsState;
    readonly constitution: ConstitutionState;
    readonly proposals: ProposalsState;
    readonly capabilities: CapabilitiesState;
    readonly treasury: TreasuryState;
    readonly outcome: OutcomeState;
    readonly activity: ActivityState;
  };
}

const DEFAULT_MS_PER_TICK = 60_000;

/**
 * Execute a run to termination.
 *
 * Terminates on: release verified, horizon reached, budget exhausted, tick
 * ceiling. The tick ceiling is a safeguard rather than a scenario feature — a run
 * that cannot end cannot be analyzed.
 */
export async function executeRun(config: RunConfig): Promise<RunResult> {
  const scenario = config.scenario;
  const horizonMs = scenario.horizonMs ?? DEFAULT_HORIZON_MS;
  const msPerTick = scenario.msPerTick ?? DEFAULT_MS_PER_TICK;
  const enforceCapabilities = config.enforceCapabilities ?? true;

  const store = new InMemoryEventStore({
    recorderDid: config.recorder.did,
    recorderPrivateKey: config.recorder.privateKey,
  });
  await store.registerRun({ runId: config.runId, recorderDid: config.recorder.did });

  const admissions = new StaticAdmissionRegistry();
  const gateway = new Gateway({
    store,
    admissions,
    // The run clock is simulated, so real wall-clock skew is irrelevant here and
    // would only reject our own synthetic timestamps.
    maxClockSkewMs: Number.MAX_SAFE_INTEGER,
  });

  const manifest: RunManifest = {
    runId: config.runId,
    epoch: {
      scenarioVersion: scenario.scenarioId,
      harnessVersion: "0.1.0",
      promptSetVersion: "deterministic-1",
      modelRosterVersion: config.participants.map((p) => p.adapter.modelIdentifier).join(","),
      evaluatorVersion: "1",
    },
    recorderDid: config.recorder.did,
    evaluatorDid: config.evaluator.did,
    horizonMs,
    confirmatory: config.confirmatory ?? false,
    ...(config.arm === undefined
      ? {}
      : {
          block: {
            blockId: `${config.runId}-block`,
            arm: config.arm,
            blockSeed: config.runId,
            executionOrder: 1,
          },
        }),
  };

  const writer = new EventWriter({
    gateway,
    runId: config.runId,
    startWallTimeMs: Date.UTC(2026, 0, 1, 0, 0, 0),
  });

  // Genesis. The manifest hash goes inside the record, so a run's membership in a
  // confirmatory set is checkable rather than asserted (ADR-0009).
  admissions.admit(config.runId, {
    did: config.controller.did,
    participantType: "controller",
    admissionCredentialId: "adm-controller",
  });
  writer.register(config.controller, "controller", "adm-controller");
  admissions.admit(config.runId, {
    did: config.evaluator.did,
    participantType: "evaluator",
    admissionCredentialId: "adm-evaluator",
  });
  writer.register(config.evaluator, "evaluator", "adm-evaluator");

  await writer.append(config.controller.did, EventTypes.RUN_STARTED, {
    scenarioId: scenario.scenarioId,
    epoch: manifest.epoch,
    ...(manifest.block === undefined ? {} : { block: manifest.block }),
    horizonMs,
    evaluatorDid: config.evaluator.did,
    confirmatory: manifest.confirmatory,
    manifestHash: hashCanonical(manifest as never),
  });

  await writer.append(config.controller.did, EventTypes.CONSTITUTION_ADOPTED, {
    constitutionId: "genesis",
    version: 1,
    rules: genesisRules(),
  });

  for (const participant of config.participants) {
    const credentialId = `adm-${participant.keyPair.did.slice(-8)}`;
    admissions.admit(config.runId, {
      did: participant.keyPair.did,
      participantType: "agent",
      admissionCredentialId: credentialId,
    });
    writer.register(participant.keyPair, "agent", credentialId);

    await writer.append(config.controller.did, EventTypes.PARTICIPANT_ADMITTED, {
      did: participant.keyPair.did,
      participantType: "agent",
      admissionCredentialId: credentialId,
      terminalHumanDids: [participant.terminalHumanDid],
      lineageDepth: 1,
      lineagePseudonym: participant.lineagePseudonym,
      ...(participant.declaredAutonomy === undefined
        ? {}
        : { declaredAutonomy: participant.declaredAutonomy }),
    });

    await writer.append(config.controller.did, EventTypes.BUDGET_ALLOCATED, {
      toDid: participant.keyPair.did,
      credits: scenario.genesisCreditsPerParticipant,
    });
  }

  for (const item of scenario.workItems) {
    await writer.append(config.controller.did, EventTypes.WORK_ITEM_OPENED, {
      workItemId: item.workItemId,
      mandatory: item.mandatory,
    });
  }

  // ---- main loop ----

  const claimedWork = new Map<string, string>();
  const completedWork = new Set<string>();
  let tick = 0;
  let terminationReason: RunTerminationReason | undefined;

  const readState = async () => {
    const events = [];
    for await (const event of store.read(config.runId)) events.push(event);
    const snapshots = projectAll(coreProjectors as never, events, config.runId);
    return {
      run: snapshots.get(runProjector.id)?.state as RunState,
      participants: snapshots.get(participantsProjector.id)?.state as ParticipantsState,
      constitution: snapshots.get(constitutionProjector.id)?.state as ConstitutionState,
      proposals: snapshots.get(proposalsProjector.id)?.state as ProposalsState,
      capabilities: snapshots.get(capabilitiesProjector.id)?.state as CapabilitiesState,
      treasury: snapshots.get(treasuryProjector.id)?.state as TreasuryState,
      outcome: snapshots.get(outcomeProjector.id)?.state as OutcomeState,
      activity: snapshots.get(activityProjector.id)?.state as ActivityState,
      logicalTime: (await store.head(config.runId))?.logicalTime ?? 0,
    };
  };

  while (tick < scenario.maxTicks) {
    tick++;
    writer.advanceClock(msPerTick);
    const state = await readState();

    if (state.outcome.shipped) {
      terminationReason = RunTerminationReason.SHIPPED;
      break;
    }
    if (elapsedRunClockMs(state.run) >= horizonMs) {
      terminationReason = RunTerminationReason.HORIZON_REACHED;
      break;
    }

    // Fair round-robin, rotated by tick so no agent is permanently first (§27).
    const order = rotate(config.participants, tick);
    let anyProgress = false;

    for (const participant of order) {
      const projected = await readState();
      const view = buildView(
        participant,
        projected,
        scenario,
        claimedWork,
        completedWork,
        horizonMs,
        enforceCapabilities,
      );

      // Scarcity applies even to deterministic agents, or a deterministic arm
      // would face different constraints from a model-driven one (§21.1).
      const cost = invocationCost(participant.adapter);
      if (view.remainingCredits < cost.credits) continue;

      const requests = await participant.adapter.decide(view);
      await writer.append(participant.keyPair.did, EventTypes.SPEND_RECORDED, {
        account: participant.keyPair.did,
        credits: cost.credits,
        purpose: "governance",
      });

      for (const request of requests) {
        const applied = await applyRequest({
          request,
          participant,
          writer,
          store,
          runId: config.runId,
          controller: config.controller,
          evaluator: config.evaluator,
          scenario,
          claimedWork,
          completedWork,
          enforceCapabilities,
          readState,
        });
        if (applied) anyProgress = true;
        else break; // Stop at the first refusal (§24.2).
      }

      // A verified release ends the run. Letting the rest of the round proceed
      // would append events after the outcome was already determined, and the
      // primary outcome is time to *first* release.
      if ((await readState()).outcome.shipped) break;
    }

    const after = await readState();
    if (after.treasury.exhausted) {
      terminationReason = RunTerminationReason.BUDGET_EXHAUSTED;
      break;
    }
    // No agent could afford to act and nothing changed: a stalled organization,
    // which is an outcome rather than an error (§47.4).
    if (!anyProgress && allBankrupt(config.participants, after)) {
      terminationReason = RunTerminationReason.BUDGET_EXHAUSTED;
      break;
    }
  }

  const finalReason = terminationReason ?? RunTerminationReason.HORIZON_REACHED;
  await writer.append(config.controller.did, EventTypes.RUN_TERMINATED, {
    reason: finalReason,
    ...(terminationReason === undefined ? { note: "tick ceiling reached" } : {}),
  });

  const final = await readState();
  return {
    runId: config.runId,
    ticks: tick,
    terminationReason: finalReason,
    validity: final.run.validity,
    shipped: final.outcome.shipped,
    ...(final.run.timeToReleaseMs === undefined
      ? {}
      : { timeToReleaseMs: final.run.timeToReleaseMs }),
    horizonMs,
    eventCount: (await store.head(config.runId))?.eventCount ?? 0,
    manifest,
    store,
    state: {
      run: final.run,
      participants: final.participants,
      constitution: final.constitution,
      proposals: final.proposals,
      capabilities: final.capabilities,
      treasury: final.treasury,
      outcome: final.outcome,
      activity: final.activity,
    },
  };
}

function rotate<T>(items: readonly T[], by: number): readonly T[] {
  if (items.length === 0) return items;
  const offset = by % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function allBankrupt(
  participants: readonly ParticipantSpec[],
  state: { readonly treasury: TreasuryState },
): boolean {
  // An empty population cannot be bankrupt. Without this guard `every` returns
  // true vacuously, and a run with no participants terminates as
  // budget_exhausted on tick one instead of running to the horizon.
  if (participants.length === 0) return false;

  return participants.every((participant) => {
    const allocated = state.treasury.creditsByAccount.get(participant.keyPair.did) ?? 0;
    const spent = state.treasury.spentByAccount.get(participant.keyPair.did) ?? 0;
    return allocated - spent < invocationCost(participant.adapter).credits;
  });
}

/**
 * Capabilities an agent believes it holds in the unenforced arm.
 *
 * §49.6 Condition F: "Agents may discuss governance, but all have broad tool
 * access." Without this the arm does not test what it is meant to test — agents
 * gate their own behaviour on the grants they can see, so they would decline to
 * act even though nothing would have stopped them. The arm would then measure
 * agent self-restraint rather than the presence or absence of enforcement.
 */
const AMBIENT_NAMESPACES: readonly string[] = [
  "repo",
  "deploy",
  "work",
  "governance",
  "treasury",
];

function buildView(
  participant: ParticipantSpec,
  state: Awaited<ReturnType<typeof buildStateShape>>,
  scenario: Scenario,
  claimedWork: ReadonlyMap<string, string>,
  completedWork: ReadonlySet<string>,
  horizonMs: number,
  enforceCapabilities: boolean,
): AgentView {
  const did = participant.keyPair.did;
  const allocated = state.treasury.creditsByAccount.get(did) ?? 0;
  const spent = state.treasury.spentByAccount.get(did) ?? 0;

  const openProposals = [...state.proposals.byId.values()]
    .filter((p) => p.status === "open")
    .map((p) => ({
      proposalId: p.proposalId,
      kind: p.kind,
      title: p.title,
      proposerDid: p.proposerDid,
      closesAtLogicalTime: p.closesAtLogicalTime,
      hasVoted: p.votes.has(did),
    }));

  const openWorkItems = scenario.workItems
    .filter((item) => !completedWork.has(item.workItemId))
    .map((item) => {
      const claimedBy = claimedWork.get(item.workItemId);
      return claimedBy === undefined
        ? { workItemId: item.workItemId }
        : { workItemId: item.workItemId, claimedBy };
    });

  return {
    selfDid: did,
    logicalTime: state.logicalTime,
    runClockMs: elapsedRunClockMs(state.run),
    horizonMs,
    recentMessages: [],
    openProposals,
    myGrants: enforceCapabilities
      ? [...state.capabilities.grants.values()]
          .filter((g) => g.toDid === did && !g.revoked)
          .map((g) => ({ grantId: g.grantId, namespace: g.namespace }))
      : AMBIENT_NAMESPACES.map((namespace) => ({
          grantId: `ambient:${namespace}`,
          namespace,
        })),
    participantDids: [...state.participants.byDid.keys()],
    constitutionRuleIds: [...state.constitution.rules.keys()],
    openWorkItems,
    remainingCredits: allocated - spent,
    workComplete: scenario.workItems
      .filter((item) => item.mandatory)
      .every((item) => completedWork.has(item.workItemId)),
  };
}

/** Only for inferring the state shape; never called. */
declare function buildStateShape(): Promise<{
  run: RunState;
  participants: ParticipantsState;
  constitution: ConstitutionState;
  proposals: ProposalsState;
  capabilities: CapabilitiesState;
  treasury: TreasuryState;
  outcome: OutcomeState;
  activity: ActivityState;
  logicalTime: number;
}>;

interface ApplyContext {
  readonly request: ActionRequest;
  readonly participant: ParticipantSpec;
  readonly writer: EventWriter;
  readonly store: InMemoryEventStore;
  readonly runId: string;
  readonly controller: KeyPair;
  readonly evaluator: KeyPair;
  readonly scenario: Scenario;
  readonly claimedWork: Map<string, string>;
  readonly completedWork: Set<string>;
  readonly enforceCapabilities: boolean;
  readonly readState: () => Promise<Awaited<ReturnType<typeof buildStateShape>>>;
}

/**
 * Authorize and apply one request.
 *
 * Returns false when the request was refused. A refusal is always recorded
 * (§20.7): a denial that leaves no trace is a hole in the research record, and the
 * unenforced-governance arm depends on denials being comparable across conditions.
 */
async function applyRequest(ctx: ApplyContext): Promise<boolean> {
  const { request, participant, writer } = ctx;
  const did = participant.keyPair.did;
  const state = await ctx.readState();

  const requireCapability = async (namespace: string): Promise<boolean> => {
    const decision = authorize(state.capabilities, {
      actorDid: did,
      namespace,
      atLogicalTime: state.logicalTime,
    });
    await writer.append(ctx.controller.did, EventTypes.AUTHORIZATION_DECIDED, {
      decisionId: `auth-${state.logicalTime}`,
      actorDid: did,
      namespace,
      allowed: decision.allowed,
      grantIdsUsed: decision.grantIdsUsed,
      reason: decision.reason,
    });
    if (decision.allowed) return true;

    await writer.append(ctx.controller.did, EventTypes.ACTION_DENIED, {
      actorDid: did,
      attemptedNamespace: namespace,
      reason: decision.reason,
    });
    // Condition F: record the denial, then permit anyway, so the two arms differ
    // only in enforcement and not in what is observable (§49.6).
    return !ctx.enforceCapabilities;
  };

  switch (request.type) {
    case "noop":
      return true;

    case "post_message":
      await writer.append(did, EventTypes.MESSAGE_POSTED, {
        channelId: request.channelId,
        text: request.text,
      });
      return true;

    case "open_proposal": {
      const proposalId = `p-${state.logicalTime}`;
      const payload = {
        proposalId,
        kind: request.kind,
        title: request.title,
        rationale: request.rationale,
        actions: request.actions,
        ...(request.constitutionalBasis === undefined
          ? {}
          : { constitutionalBasis: request.constitutionalBasis }),
        closesAtLogicalTime:
          state.logicalTime + (request.closesAfterLogicalTicks ?? 10),
      };

      const validation = validateProposal(payload, {
        constitution: state.constitution,
        capabilities: state.capabilities,
        participants: state.participants,
        proposals: state.proposals,
        proposerDid: did,
        atLogicalTime: state.logicalTime,
      });
      if (!validation.valid) {
        // Rejected at proposal time, so nobody votes on something that cannot
        // happen.
        await writer.append(ctx.controller.did, EventTypes.ACTION_DENIED, {
          actorDid: did,
          attemptedNamespace: "governance.propose",
          reason: validation.problems.join("; "),
        });
        return false;
      }

      await writer.append(did, EventTypes.PROPOSAL_OPENED, payload);
      return true;
    }

    case "cast_vote": {
      const proposal = state.proposals.byId.get(request.proposalId);
      if (proposal === undefined || proposal.status !== "open") return false;
      await writer.append(did, EventTypes.VOTE_CAST, {
        proposalId: request.proposalId,
        choice: { type: request.choice },
        ...(request.rationale === undefined ? {} : { rationale: request.rationale }),
      });
      return true;
    }

    case "close_proposal": {
      const proposal = state.proposals.byId.get(request.proposalId);
      if (proposal === undefined || proposal.status !== "open") return false;

      const tally = tallyProposal(proposal, state.participants);
      const quorum = evaluateQuorum(
        [...state.constitution.rules.values()],
        tally,
        state.logicalTime,
      );

      await writer.append(ctx.controller.did, EventTypes.PROPOSAL_CLOSED, {
        proposalId: request.proposalId,
        outcome: quorum.passed ? "passed" : "failed",
        tally: {
          yes: tally.yes,
          no: tally.no,
          abstain: tally.abstain,
          eligibleVoters: tally.eligibleVoters,
          distinctLineages: tally.distinctLineages,
        },
        ...(quorum.ruleId === undefined ? {} : { quorumRuleId: quorum.ruleId }),
        reason: quorum.reason,
      });

      if (!quorum.passed) return true;

      const after = await ctx.readState();
      const execution = executeProposal(
        {
          proposalId: proposal.proposalId,
          kind: proposal.kind as never,
          title: proposal.title,
          rationale: "",
          actions: proposal.actions,
          closesAtLogicalTime: proposal.closesAtLogicalTime,
        },
        {
          constitution: after.constitution,
          capabilities: after.capabilities,
          participants: after.participants,
          proposals: after.proposals,
          proposerDid: proposal.proposerDid,
          atLogicalTime: after.logicalTime,
        },
      );

      if (!execution.executed) {
        await writer.append(ctx.controller.did, EventTypes.PROPOSAL_EXECUTION_FAILED, {
          proposalId: proposal.proposalId,
          reason: execution.reason,
        });
        return true;
      }

      for (const effect of execution.effects) {
        switch (effect.kind) {
          case "grant_capability":
            await writer.append(ctx.controller.did, EventTypes.CAPABILITY_GRANTED, {
              grantId: effect.grantId,
              toDid: effect.toDid,
              namespace: effect.namespace,
              ...(effect.constraints === undefined
                ? {}
                : { constraints: effect.constraints }),
              redelegable: effect.redelegable,
              grantedByProposalId: proposal.proposalId,
            });
            break;
          case "revoke_capability":
            await writer.append(ctx.controller.did, EventTypes.CAPABILITY_REVOKED, {
              grantId: effect.grantId,
            });
            break;
          case "adopt_constitution":
            await writer.append(ctx.controller.did, EventTypes.CONSTITUTION_ADOPTED, {
              constitutionId: "genesis",
              version: effect.version,
              rules: effect.rules,
            });
            break;
          case "allocate_budget":
            await writer.append(ctx.controller.did, EventTypes.BUDGET_ALLOCATED, {
              toDid: effect.toDid,
              credits: effect.credits,
            });
            break;
          case "sanction":
            await writer.append(ctx.controller.did, EventTypes.PARTICIPANT_SUSPENDED, {
              did: effect.targetDid,
              reasonCode: effect.reasonCode,
            });
            break;
          default:
            break;
        }
      }

      await writer.append(ctx.controller.did, EventTypes.PROPOSAL_EXECUTED, {
        proposalId: proposal.proposalId,
        appliedActions: execution.effects.length,
      });
      return true;
    }

    case "delegate_capability": {
      const check = checkAttenuation(
        state.capabilities,
        did,
        {
          parentGrantId: request.parentGrantId,
          toDid: request.toDid,
          namespace: request.namespace,
          ...(request.constraint === undefined
            ? {}
            : { constraintSource: request.constraint.source }),
        },
        state.logicalTime,
      );

      if (!check.permitted) {
        await writer.append(ctx.controller.did, EventTypes.ACTION_DENIED, {
          actorDid: did,
          attemptedNamespace: request.namespace,
          reason: check.reason,
        });
        return false;
      }

      await writer.append(did, EventTypes.CAPABILITY_ATTENUATED, {
        grantId: `${request.parentGrantId}-att-${state.logicalTime}`,
        toDid: request.toDid,
        namespace: request.namespace,
        ...(request.constraint === undefined ? {} : { constraints: request.constraint }),
        redelegable: false,
        parentGrantId: request.parentGrantId,
      });
      return true;
    }

    case "claim_work": {
      if (!(await requireCapability("repo.commit"))) return false;
      if (ctx.claimedWork.has(request.workItemId)) return false;
      ctx.claimedWork.set(request.workItemId, did);
      await writer.append(did, EventTypes.WORK_ITEM_CLAIMED, {
        workItemId: request.workItemId,
      });
      return true;
    }

    case "complete_work": {
      if (ctx.claimedWork.get(request.workItemId) !== did) return false;
      ctx.completedWork.add(request.workItemId);
      await writer.append(did, EventTypes.WORK_ITEM_COMPLETED, {
        workItemId: request.workItemId,
        acceptanceFraction: request.acceptanceFraction,
      });
      return true;
    }

    case "submit_release": {
      if (state.outcome.shipped) {
        // Already verified. Refusing keeps the log free of releases that follow a
        // decided outcome.
        return false;
      }
      await writer.append(did, EventTypes.RELEASE_SUBMITTED, {
        releaseId: request.releaseId,
      });

      // The evaluator decides, and only the evaluator. Governance cannot vote
      // itself successful (§59.10), so this is signed with the evaluator key and
      // computed from the protected work items rather than from anything an agent
      // said.
      const mandatory = ctx.scenario.workItems.filter((item) => item.mandatory);
      const passed = mandatory.filter((item) => ctx.completedWork.has(item.workItemId));
      const allPassed = passed.length === mandatory.length && mandatory.length > 0;
      const fraction =
        mandatory.length === 0
          ? "0"
          : (passed.length / mandatory.length).toFixed(2).replace(/\.?0+$/, "") || "0";

      if (allPassed) {
        await writer.append(ctx.evaluator.did, EventTypes.RELEASE_VERIFIED, {
          releaseId: request.releaseId,
          mandatoryTestsPassed: passed.length,
          mandatoryTestsTotal: mandatory.length,
          acceptanceFraction: "1",
          minimumOperatingPeriodMet: true,
          evaluatorSignature: "evaluator-attested",
        });
      } else {
        await writer.append(ctx.evaluator.did, EventTypes.RELEASE_REJECTED, {
          releaseId: request.releaseId,
          mandatoryTestsPassed: passed.length,
          mandatoryTestsTotal: mandatory.length,
          acceptanceFraction: fraction,
          failures: mandatory
            .filter((item) => !ctx.completedWork.has(item.workItemId))
            .map((item) => item.workItemId),
        });
      }
      return true;
    }

    default:
      return false;
  }
}
