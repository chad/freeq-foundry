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
  deterministicKeyPair as deterministicKeyPairFor,
  hashCanonical,
  type KeyPair,
  type RunManifest,
} from "@freeq-foundry/protocol";
import { InMemoryEventStore } from "@freeq-foundry/event-store";
import { Gateway, StaticAdmissionRegistry } from "@freeq-foundry/gateway";
import {
  AdmissionService,
  ChallengeRegistry,
  RevocationRegistry,
  buildProvenanceProof,
  computeBlastRadius,
  createChallenge,
  defaultResolvers,
  issueAgentCreationCredential,
  issueHumanRootCredential,
  respondToChallenge,
  signRevocation,
  type LineageConstraints,
  type SignedCredential,
} from "@freeq-foundry/identity";
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
import { Repository, type MergePolicy } from "@freeq-foundry/repository";
import { NodeSubprocessSandbox, type Sandbox } from "@freeq-foundry/sandbox";
import {
  evaluateRelease,
  publicCriteria,
  type ProtectedTestBundle,
} from "@freeq-foundry/evaluation";
import { EventWriter } from "./writer.js";
import { starterFiles, webhookTestBundle, workItems as webhookWorkItems, type ProductWorkItem } from "./scenario-webhook.js";

export type WorkItem = ProductWorkItem;

export interface Scenario {
  readonly scenarioId: string;
  readonly workItems: readonly WorkItem[];
  /** Files the organization starts with (§9.2). */
  readonly starterFiles: ReadonlyMap<string, string>;
  /** Protected acceptance tests. Never exposed to an agent (§30). */
  readonly testBundle: ProtectedTestBundle;
  /** Credits allocated to each participant at genesis (§21.4). */
  readonly genesisCreditsPerParticipant: number;
  /** Hard tick ceiling. A run that cannot end is a run that cannot be analyzed. */
  readonly maxTicks: number
  readonly horizonMs?: number;
  /** Simulated milliseconds per tick, so the run clock advances deterministically. */
  readonly msPerTick?: number;
  readonly mergePolicy?: MergePolicy;
  readonly mainBranch?: string;
}

/** The `webhook-saas-v1` scenario: a real, small product. */
export function webhookScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    scenarioId: "webhook-saas-v1",
    workItems: webhookWorkItems(),
    starterFiles: starterFiles(),
    testBundle: webhookTestBundle(),
    genesisCreditsPerParticipant: 400,
    maxTicks: 120,
    msPerTick: 60_000,
    mainBranch: "main",
    ...overrides,
  };
}

export interface ParticipantSpec {
  readonly keyPair: KeyPair;
  readonly adapter: AgentAdapter;
  /**
   * Human root this participant's lineage terminates in.
   *
   * The controller issues the credential chain, so this is the *scenario's* claim
   * about who introduced the agent. Verification still runs: an internally issued
   * chain that fails the nine conditions is refused like any other.
   */
  readonly humanRoot: KeyPair;
  readonly declaredAutonomy?: "autonomous" | "supervised" | "teleoperated";
  /** Depth of the chain to build. 1 means the human created this agent directly. */
  readonly lineageDepth?: number;
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
  /** Lineage depth and fan-out ceilings (§11.4 condition 9). */
  readonly lineageConstraints?: LineageConstraints;
  /**
   * Credentials to revoke mid-run, keyed by the tick at which they take effect.
   *
   * Exists so §11.10 — root revocation suspends descendants — can be exercised
   * inside a real run rather than only in unit tests.
   */
  readonly revokeAtTick?: ReadonlyMap<number, string>;
  /**
   * When false, capability checks are bypassed — §49.6 Condition F.
   *
   * This is the platform's central claim under test: whether executable
   * capability enforcement matters. Denials are still recorded, so the two arms
   * produce comparable records.
   */
  readonly enforceCapabilities?: boolean;
  /** Override the sandbox, so a container-backed runner can be substituted (§31). */
  readonly sandbox?: Sandbox;
}

export interface RunResult {
  readonly runId: string;
  readonly repository: Repository;
  /** Signed evaluator verdicts, in order. */
  readonly evaluations: readonly Awaited<ReturnType<typeof evaluateRelease>>[];
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
 * Build a CI smoke test for a specific tree.
 *
 * Each module under `src/` is imported individually rather than through the entry
 * point. A feature branch legitimately has an incomplete tree — the starter entry
 * point re-exports modules that do not exist yet — so importing it would fail every
 * branch until the last one landed, and CI would be useless exactly when it matters.
 *
 * Deliberately weak beyond that: CI is the organization's own gate, and making it
 * strong would do the evaluator's job for them. A branch whose code does not parse
 * must not become mergeable, and that is all this asserts.
 */
function buildCiSmokeTest(files: ReadonlyMap<string, string>): string {
  const modules = [...files.keys()]
    .filter((path) => path.startsWith("src/") && path.endsWith(".mjs"))
    .filter((path) => path !== "src/index.mjs")
    .sort();

  if (modules.length === 0) {
    return 'console.log("smoke ok: no modules to check");';
  }

  return [
    ...modules.map(
      (path) =>
        `await import("../${path}").catch((error) => { console.error("${path}: " + error.message); process.exit(1); });`,
    ),
    `console.log("smoke ok: ${modules.length} module(s)");`,
  ].join("\n");
}

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

  // Real provenance verification. Every participant presents a signed credential
  // chain and proves key possession; nothing is admitted on assertion alone
  // (§6.2, §6.3, §11.4).
  const resolvers = defaultResolvers();
  const revocations = new RevocationRegistry();
  const challenges = new ChallengeRegistry();
  const provenance = new AdmissionService({
    runId: config.runId,
    resolvers,
    revocations,
    ...(config.lineageConstraints === undefined
      ? {}
      : { constraints: config.lineageConstraints }),
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

  const mainBranch = scenario.mainBranch ?? "main";
  const repository = new Repository(
    scenario.mergePolicy === undefined ? {} : { mergePolicy: scenario.mergePolicy },
  );
  const sandbox = config.sandbox ?? new NodeSubprocessSandbox();
  const evaluations: Awaited<ReturnType<typeof evaluateRelease>>[] = [];

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

  const genesisInstant = new Date(writer.wallTimeMs).toISOString();
  const credentialsByDid = new Map<string, readonly SignedCredential[]>();
  const admittedParticipants: ParticipantSpec[] = [];
  const humanRoots = new Map<string, KeyPair>();

  for (const participant of config.participants) {
    humanRoots.set(participant.humanRoot.did, participant.humanRoot);
  }

  // One human-root credential per distinct root, issued by the controller. §11.2
  // permits controller-issued roots for a prototype; a public run needs stronger
  // verification (§58.2).
  const rootCredentials = new Map<string, SignedCredential>();
  for (const [did, keyPair] of humanRoots) {
    rootCredentials.set(
      did,
      issueHumanRootCredential({
        id: `hrc-${did.slice(-8)}`,
        subjectDid: did,
        issuerDid: config.controller.did,
        issuerPrivateKey: config.controller.privateKey,
        verificationMethod: "controller_issued",
        issuedAt: genesisInstant,
      }),
    );
    void keyPair;
  }

  for (const participant of config.participants) {
    const rootCredential = rootCredentials.get(participant.humanRoot.did) as SignedCredential;
    const chain = buildChain(
      participant,
      rootCredential,
      genesisInstant,
      participant.lineageDepth ?? 1,
    );

    // Key possession: challenge and response, not an assumption (§6.3).
    const challenge = challenges.issue(
      createChallenge({
        subjectDid: participant.keyPair.did,
        runId: config.runId,
        issuedAt: genesisInstant,
        nonce: `nonce-${participant.keyPair.did.slice(-12)}`,
      }),
    );
    const possession = challenges.consume(
      respondToChallenge(challenge, participant.keyPair.privateKey),
      genesisInstant,
    );

    const outcome = await provenance.admit(
      buildProvenanceProof(participant.keyPair.did, chain),
      { at: genesisInstant, keyPossessionProved: possession.proved },
    );

    if (!outcome.admitted) {
      // A refused applicant is recorded and excluded. Silently dropping them would
      // leave the population unexplained (§12.5).
      await writer.append(config.controller.did, EventTypes.PARTICIPANT_REJECTED, {
        did: participant.keyPair.did,
        reason: outcome.reason,
        detail: outcome.detail,
      });
      continue;
    }

    credentialsByDid.set(participant.keyPair.did, chain);
    admittedParticipants.push(participant);

    admissions.admit(config.runId, {
      did: participant.keyPair.did,
      participantType: "agent",
      admissionCredentialId: outcome.admissionCredentialId,
    });
    writer.register(participant.keyPair, "agent", outcome.admissionCredentialId);

    await writer.append(config.controller.did, EventTypes.CREDENTIAL_ISSUED, {
      subjectDid: participant.keyPair.did,
      credentialIds: chain.map((credential) => credential.id),
      chainHash: buildProvenanceProof(participant.keyPair.did, chain).chainHash,
    });

    await writer.append(config.controller.did, EventTypes.PARTICIPANT_ADMITTED, {
      did: participant.keyPair.did,
      participantType: "agent",
      admissionCredentialId: outcome.admissionCredentialId,
      terminalHumanDids: outcome.terminalHumanDids,
      lineageDepth: outcome.lineageDepth,
      lineagePseudonym: outcome.lineagePseudonym,
      ...(participant.declaredAutonomy === undefined
        ? {}
        : { declaredAutonomy: participant.declaredAutonomy }),
    });

    await writer.append(config.controller.did, EventTypes.BUDGET_ALLOCATED, {
      toDid: participant.keyPair.did,
      credits: scenario.genesisCreditsPerParticipant,
    });
  }

  // Seed the repository. The controller's initial commit is the only one that does
  // not require a capability grant, because at genesis no grant can exist yet.
  repository.initialize(mainBranch, scenario.starterFiles, {
    actorDid: config.controller.did,
    terminalHumanDids: [config.controller.did],
    capabilityGrantId: "genesis",
  });

  for (const item of scenario.workItems) {
    await writer.append(config.controller.did, EventTypes.WORK_ITEM_OPENED, {
      workItemId: item.workItemId,
      mandatory: item.mandatory,
      description: item.description,
      path: item.path,
    });
  }

  // ---- main loop ----

  const claimedWork = new Map<string, string>();
  const completedWork = new Set<string>();
  /** Branches an agent has committed to, by work item. */
  const pushedBranches = new Map<string, string>();
  /** Branches already the subject of a pull request. */
  const proposedBranches = new Set<string>();
  /** Pull requests each agent has already reviewed, to avoid re-reviewing. */
  const reviewed = new Map<string, Set<string>>();
  /** Commits the evaluator has already rejected, so agents do not resubmit them. */
  const rejectedCommits = new Set<string>();
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

    // Mid-run revocation, if the scenario asked for one. §11.10: revoking a
    // credential suspends every participant whose provenance runs through it.
    const toRevoke = config.revokeAtTick?.get(tick);
    if (toRevoke !== undefined) {
      const allCredentials = [...credentialsByDid.values()].flat();
      const radius = computeBlastRadius(toRevoke, allCredentials);
      revocations.revoke(
        signRevocation(
          {
            credentialId: toRevoke,
            revokerDid: config.controller.did,
            reasonCode: "controller_action",
            effectiveAt: new Date(writer.wallTimeMs).toISOString(),
          },
          config.controller.privateKey,
        ),
      );
      await writer.append(config.controller.did, EventTypes.CREDENTIAL_REVOKED, {
        credentialId: toRevoke,
        revokerDid: config.controller.did,
        reasonCode: "controller_action",
        effectiveAt: new Date(writer.wallTimeMs).toISOString(),
        affectedParticipantDids: radius.affectedDids,
      });
      for (const did of provenance.suspendAffectedBy(toRevoke)) {
        admissions.suspend(config.runId, did);
        await writer.append(config.controller.did, EventTypes.PARTICIPANT_SUSPENDED, {
          did,
          reasonCode: "credential_revoked",
          causedByCredentialId: toRevoke,
        });
      }
    }

    // Fair round-robin, rotated by tick so no agent is permanently first (§27).
    const order = rotate(
      admittedParticipants.filter((p) => !provenance.isSuspended(p.keyPair.did)),
      tick,
    );
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
        { repository, mainBranch, pushedBranches, proposedBranches, reviewed, rejectedCommits },
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
          repository,
          sandbox,
          mainBranch,
          pushedBranches,
          proposedBranches,
          reviewed,
          rejectedCommits,
          evaluations,
          lineageOf: (did) =>
            projected.participants.byDid.get(did)?.lineagePseudonym ?? did,
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
    const active = admittedParticipants.filter(
      (p) => !provenance.isSuspended(p.keyPair.did),
    );
    if (!anyProgress && allBankrupt(active, after)) {
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
    repository,
    evaluations,
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

/**
 * Build a credential chain of the requested depth.
 *
 * Depth 1 is the human creating the agent directly. Deeper chains insert
 * intermediate agents, each of which must have been granted redelegation — which
 * is what makes the §11.6 spawning rule testable inside a run.
 */
function buildChain(
  participant: ParticipantSpec,
  rootCredential: SignedCredential,
  issuedAt: string,
  depth: number,
): readonly SignedCredential[] {
  if (depth <= 1) {
    return [
      issueAgentCreationCredential({
        id: `acc-${participant.keyPair.did.slice(-8)}`,
        parentDid: participant.humanRoot.did,
        childDid: participant.keyPair.did,
        parentPrivateKey: participant.humanRoot.privateKey,
        relationship: "created",
        issuedAt,
        redelegable: true,
      }),
      rootCredential,
    ];
  }

  // Deterministic intermediates, so a deeper chain is still byte-reproducible.
  const intermediates = Array.from({ length: depth - 1 }, (_, i) =>
    deterministicKeyPairFor(`${participant.keyPair.did}-mid-${i}`),
  );
  const edges: SignedCredential[] = [];
  let parent = participant.humanRoot;

  for (const [index, intermediate] of intermediates.entries()) {
    edges.push(
      issueAgentCreationCredential({
        id: `acc-${participant.keyPair.did.slice(-8)}-mid-${index}`,
        parentDid: parent.did,
        childDid: intermediate.did,
        parentPrivateKey: parent.privateKey,
        relationship: "created",
        issuedAt,
        redelegable: true,
      }),
    );
    parent = intermediate;
  }

  edges.push(
    issueAgentCreationCredential({
      id: `acc-${participant.keyPair.did.slice(-8)}`,
      parentDid: parent.did,
      childDid: participant.keyPair.did,
      parentPrivateKey: parent.privateKey,
      relationship: "spawned",
      issuedAt,
      redelegable: true,
    }),
  );

  // Ordered from the subject's own edge outward to the root (§11.4).
  return [...edges.reverse(), rootCredential];
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
  production: {
    readonly repository: Repository;
    readonly mainBranch: string;
    readonly pushedBranches: ReadonlyMap<string, string>;
    readonly proposedBranches: ReadonlySet<string>;
    readonly reviewed: ReadonlyMap<string, ReadonlySet<string>>;
    readonly rejectedCommits: ReadonlySet<string>;
  },
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
    grantsByDid: new Map(
      [...state.participants.byDid.keys()].map((candidate) => [
        candidate,
        enforceCapabilities
          ? [...state.capabilities.grants.values()]
              .filter((grant) => grant.toDid === candidate && !grant.revoked)
              .map((grant) => grant.namespace)
          : AMBIENT_NAMESPACES,
      ]),
    ),
    constitutionRuleIds: [...state.constitution.rules.keys()],
    openWorkItems,
    remainingCredits: allocated - spent,
    // Complete means *merged into main*, not merely committed. An implementation on
    // a feature branch is not shipped.
    workComplete: scenario.workItems
      .filter((item) => item.mandatory)
      .every((item) => completedWork.has(item.workItemId)),
    currentCommitRejected: production.rejectedCommits.has(
      production.repository.head(production.mainBranch) ?? ("" as never),
    ),
    myUncommittedWork: [...claimedWork.entries()]
      .filter(([workItemId, claimant]) => claimant === did && !production.pushedBranches.has(workItemId))
      .map(([workItemId]) => workItemId),
    myUnproposedBranches: [...production.pushedBranches.entries()]
      .filter(
        ([workItemId, branch]) =>
          claimedWork.get(workItemId) === did && !production.proposedBranches.has(branch),
      )
      .map(([, branch]) => branch),
    reviewableePullRequests: production.repository.openPullRequests
      .filter(
        (pr) =>
          pr.authorDid !== did &&
          !(production.reviewed.get(did)?.has(pr.id) ?? false),
      )
      .map((pr) => ({
        pullRequestId: pr.id,
        authorDid: pr.authorDid,
        title: pr.title,
      })),
    openPullRequestsAuthoredByMe: production.repository.openPullRequests
      .filter((pr) => pr.authorDid === did)
      .map((pr) => pr.id),
    mergeablePullRequests: production.repository.openPullRequests
      .filter(
        (pr) =>
          production.repository.mergeability(pr.id, (reviewer) =>
            state.participants.byDid.get(reviewer)?.lineagePseudonym ?? reviewer,
          ).ok,
      )
      .map((pr) => pr.id),
    // Descriptions only. §30: an agent that could read a test could satisfy it
    // without the code working.
    acceptanceCriteria: publicCriteria(scenario.testBundle),
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
  readonly repository: Repository;
  readonly sandbox: Sandbox;
  readonly mainBranch: string;
  readonly pushedBranches: Map<string, string>;
  readonly proposedBranches: Set<string>;
  readonly reviewed: Map<string, Set<string>>;
  readonly rejectedCommits: Set<string>;
  readonly evaluations: Awaited<ReturnType<typeof evaluateRelease>>[];
  readonly lineageOf: (did: string) => string;
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

    case "commit_work": {
      if (!(await requireCapability("repo.commit"))) return false;
      if (ctx.claimedWork.get(request.workItemId) !== did) return false;

      const item = ctx.scenario.workItems.find(
        (candidate) => candidate.workItemId === request.workItemId,
      );
      if (item === undefined) return false;

      // The grant actually being exercised is recorded on the commit, so the
      // §6.4 attribution chain reaches the code itself.
      const grant = [...state.capabilities.grants.values()].find(
        (candidate) =>
          candidate.toDid === did &&
          !candidate.revoked &&
          "repo.commit".startsWith(candidate.namespace),
      );
      const grantId = grant?.grantId ?? (ctx.enforceCapabilities ? "" : "ambient");

      if (ctx.repository.head(request.branch) === undefined) {
        const created = ctx.repository.createBranch(request.branch, ctx.mainBranch);
        if (!created.ok) return false;
        await writer.append(did, EventTypes.BRANCH_CREATED, {
          branch: request.branch,
          fromBranch: ctx.mainBranch,
        });
      }

      const committed = ctx.repository.applyPatch({
        branch: request.branch,
        patch: { changes: [{ path: item.path, content: item.implementation }] },
        message: request.message,
        provenance: {
          actorDid: did,
          terminalHumanDids:
            state.participants.byDid.get(did)?.terminalHumanDids ?? [],
          capabilityGrantId: grantId,
        },
        logicalTime: state.logicalTime,
      });

      if (!committed.ok) {
        await writer.append(ctx.controller.did, EventTypes.ACTION_DENIED, {
          actorDid: did,
          attemptedNamespace: "repo.commit",
          reason: `${committed.code}: ${committed.reason}`,
        });
        return false;
      }

      ctx.pushedBranches.set(request.workItemId, request.branch);
      await writer.append(did, EventTypes.COMMIT_CREATED, {
        branch: request.branch,
        commitHash: committed.value.hash,
        path: item.path,
        workItemId: request.workItemId,
        capabilityGrantId: grantId,
      });

      // CI: run the produced tree in the sandbox. A branch that does not even
      // parse must not become mergeable.
      const files = ctx.repository.checkout(request.branch) ?? new Map<string, string>();
      const ci = await ctx.sandbox.run({
        files: new Map([...files, ["__ci__/smoke.mjs", buildCiSmokeTest(files)]]),
        entryPoint: "__ci__/smoke.mjs",
      });

      if (ci.outcome === "succeeded") ctx.repository.recordCiPass(committed.value.hash);
      // No wall-clock duration in the payload. §37.3 separates platform telemetry
      // from the canonical log for exactly this reason: a real duration varies
      // between runs, so recording it here would make a replay of identical inputs
      // produce different event hashes. Timing belongs in telemetry.
      await writer.append(ctx.controller.did, EventTypes.CI_COMPLETED, {
        branch: request.branch,
        commitHash: committed.value.hash,
        outcome: ci.outcome,
        sandboxId: ctx.sandbox.id,
      });
      return true;
    }

    case "open_pull_request": {
      const opened = ctx.repository.openPullRequest({
        sourceBranch: request.branch,
        targetBranch: ctx.mainBranch,
        title: request.title,
        authorDid: did,
        logicalTime: state.logicalTime,
      });
      if (!opened.ok) return false;
      ctx.proposedBranches.add(request.branch);
      await writer.append(did, EventTypes.PULL_REQUEST_OPENED, {
        pullRequestId: opened.value.id,
        sourceBranch: request.branch,
        targetBranch: ctx.mainBranch,
        title: request.title,
      });
      return true;
    }

    case "review_pull_request": {
      if (!(await requireCapability("repo.review"))) return false;
      const reviewOutcome = ctx.repository.addReview(request.pullRequestId, {
        reviewerDid: did,
        verdict: request.verdict,
        ...(request.note === undefined ? {} : { note: request.note }),
        logicalTime: state.logicalTime,
      });
      if (!reviewOutcome.ok) {
        // Self-review is refused by the repository, and the refusal is recorded so
        // the attempt is visible rather than silently dropped.
        await writer.append(ctx.controller.did, EventTypes.ACTION_DENIED, {
          actorDid: did,
          attemptedNamespace: "repo.review",
          reason: `${reviewOutcome.code}: ${reviewOutcome.reason}`,
        });
        return false;
      }
      const seen = ctx.reviewed.get(did) ?? new Set<string>();
      seen.add(request.pullRequestId);
      ctx.reviewed.set(did, seen);

      await writer.append(did, EventTypes.PULL_REQUEST_REVIEWED, {
        pullRequestId: request.pullRequestId,
        verdict: request.verdict,
      });
      return true;
    }

    case "merge_pull_request": {
      if (!(await requireCapability("repo.merge"))) return false;

      const pr = ctx.repository.pullRequest(request.pullRequestId);
      if (pr === undefined) return false;

      const merged = ctx.repository.merge({
        prId: request.pullRequestId,
        provenance: {
          actorDid: did,
          terminalHumanDids:
            state.participants.byDid.get(did)?.terminalHumanDids ?? [],
          capabilityGrantId:
            [...state.capabilities.grants.values()].find(
              (candidate) =>
                candidate.toDid === did &&
                !candidate.revoked &&
                "repo.merge".startsWith(candidate.namespace),
            )?.grantId ?? (ctx.enforceCapabilities ? "" : "ambient"),
        },
        logicalTime: state.logicalTime,
        lineageOf: ctx.lineageOf,
      });

      if (!merged.ok) {
        // The interesting denials live here: insufficient approvals, approvals all
        // from one lineage, CI not passed. Each is recorded (§20.7).
        await writer.append(ctx.controller.did, EventTypes.ACTION_DENIED, {
          actorDid: did,
          attemptedNamespace: "repo.merge",
          reason: `${merged.code}: ${merged.reason}`,
        });
        return false;
      }

      // Merged into main means the work item is done.
      for (const [workItemId, branch] of ctx.pushedBranches) {
        if (branch === pr.sourceBranch) ctx.completedWork.add(workItemId);
      }

      await writer.append(did, EventTypes.PULL_REQUEST_MERGED, {
        pullRequestId: request.pullRequestId,
        mergeCommitHash: merged.value.hash,
        targetBranch: ctx.mainBranch,
      });
      for (const [workItemId, branch] of ctx.pushedBranches) {
        if (branch !== pr.sourceBranch) continue;
        await writer.append(did, EventTypes.WORK_ITEM_COMPLETED, {
          workItemId,
          commitHash: merged.value.hash,
        });
      }
      return true;
    }

    case "submit_release": {
      if (state.outcome.shipped) {
        // Already verified. Refusing keeps the log free of releases that follow a
        // decided outcome.
        return false;
      }

      const head = ctx.repository.head(ctx.mainBranch);
      const files = ctx.repository.checkout(ctx.mainBranch);
      if (head === undefined || files === undefined) return false;

      await writer.append(did, EventTypes.RELEASE_SUBMITTED, {
        releaseId: request.releaseId,
        commitHash: head,
      });

      // The evaluator runs the organization's actual code against tests the
      // organization has never seen, and signs the verdict. Governance cannot
      // produce this result (§59.10).
      const evaluation = await evaluateRelease({
        releaseId: request.releaseId,
        commitHash: head,
        files,
        bundle: ctx.scenario.testBundle,
        sandbox: ctx.sandbox,
        evaluatorDid: ctx.evaluator.did,
        evaluatorPrivateKey: ctx.evaluator.privateKey,
      });
      ctx.evaluations.push(evaluation);

      if (evaluation.verified) {
        await writer.append(ctx.evaluator.did, EventTypes.RELEASE_VERIFIED, {
          releaseId: request.releaseId,
          commitHash: head,
          bundleHash: evaluation.bundleHash,
          mandatoryTestsPassed: evaluation.mandatoryPassed,
          mandatoryTestsTotal: evaluation.mandatoryTotal,
          acceptanceFraction: evaluation.acceptanceFraction,
          minimumOperatingPeriodMet: true,
          evaluatorSignature: evaluation.evaluatorSignature,
        });
      } else {
        ctx.rejectedCommits.add(head);
        await writer.append(ctx.evaluator.did, EventTypes.RELEASE_REJECTED, {
          releaseId: request.releaseId,
          commitHash: head,
          bundleHash: evaluation.bundleHash,
          mandatoryTestsPassed: evaluation.mandatoryPassed,
          mandatoryTestsTotal: evaluation.mandatoryTotal,
          acceptanceFraction: evaluation.acceptanceFraction,
          failures: evaluation.criteria
            .filter((criterion) => criterion.mandatory && !criterion.passed)
            .map((criterion) => criterion.id),
        });
        if (evaluation.secretFindings.length > 0) {
          // A release that would leak a credential is a safety event, not merely a
          // failed test (§31).
          await writer.append(ctx.controller.did, EventTypes.SAFETY_EVENT, {
            severity: "severe",
            code: "SECRET_IN_RELEASE",
            description: `secret-like content in ${evaluation.secretFindings
              .map((finding) => finding.path)
              .join(", ")}`,
          });
        }
      }
      return true;
    }

    default:
      return false;
  }
}
