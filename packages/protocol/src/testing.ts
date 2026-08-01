/**
 * Deterministic test client.
 *
 * Milestone 1 is deliberately model-free: its acceptance criteria are provable
 * with fixed keys and fixed inputs, and nothing here touches a network or an
 * LLM. That is why it comes first — the protocol can be proven correct before
 * anything expensive or nondeterministic is built on top of it.
 *
 * Spec: §50 Milestone 1, §24.8 (deterministic agents).
 */
import { attestPositionAndRecord } from "./event.js";
import { GENESIS_HASH, type Digest } from "./hash.js";
import { keyPairFromSeed, type KeyPair } from "./keys.js";
import type {
  ActionProvenance,
  DraftEvent,
  ParticipantType,
  RecordedEvent,
  VisibilityPolicy,
} from "./types.js";

/** Derive a fixed key pair from a label, so vectors are reproducible. */
export function deterministicKeyPair(label: string): KeyPair {
  const seed = new Uint8Array(32);
  const bytes = new TextEncoder().encode(label);
  for (let i = 0; i < seed.length; i++) {
    // Simple, stable, and documented. Not a KDF, and not used for real keys.
    seed[i] = (bytes[i % bytes.length] ?? 0) ^ ((i * 31) & 0xff);
  }
  return keyPairFromSeed(seed);
}

export interface TestParticipant {
  readonly did: string;
  readonly keyPair: KeyPair;
  readonly participantType: ParticipantType;
}

export function testParticipant(
  label: string,
  participantType: ParticipantType = "agent",
): TestParticipant {
  const keyPair = deterministicKeyPair(label);
  return { did: keyPair.did, keyPair, participantType };
}

export interface AppendSpec {
  readonly actor: TestParticipant;
  readonly eventType: string;
  readonly payload: unknown;
  readonly visibility?: VisibilityPolicy;
  readonly references?: readonly string[];
  readonly causationId?: string;
}

/**
 * Builds a valid, signed, chained run.
 *
 * Wall times advance by a fixed step from a fixed epoch so that two runs built
 * from the same script are byte-identical. A real gateway uses the clock; a
 * conformance vector cannot.
 */
export class TestRunBuilder {
  readonly #runId: string;
  readonly #recorder: TestParticipant;
  readonly #events: RecordedEvent[] = [];
  readonly #sequences = new Map<string, number>();
  #logicalTime = 0;
  #previousHash: Digest = GENESIS_HASH;
  #wallTimeMs: number;

  constructor(
    runId: string,
    options: {
      readonly recorder?: TestParticipant;
      readonly startWallTimeMs?: number;
    } = {},
  ) {
    this.#runId = runId;
    // One recorder per run, whose DID a verifier obtains from the run manifest
    // rather than from the events themselves (ADR-0008).
    this.#recorder = options.recorder ?? testParticipant("recorder", "controller");
    this.#wallTimeMs = options.startWallTimeMs ?? Date.UTC(2026, 0, 1, 0, 0, 0);
  }

  append(spec: AppendSpec): RecordedEvent {
    const sequence = (this.#sequences.get(spec.actor.did) ?? 0) + 1;
    this.#sequences.set(spec.actor.did, sequence);

    const provenance: ActionProvenance = {
      signerDid: spec.actor.did,
      terminalHumanDids: [spec.actor.did],
      provenancePathHashes: [],
      admissionCredentialId: `adm-${spec.actor.did.slice(-8)}`,
      directInstructionEventIds: [],
      governanceAuthorizationIds: [],
      capabilityGrantIds: [],
    };

    const draft: DraftEvent = {
      eventId: `${this.#runId}-${String(this.#logicalTime).padStart(6, "0")}`,
      runId: this.#runId,
      eventType: spec.eventType,
      schemaVersion: 1,
      actorDid: spec.actor.did,
      participantType: spec.actor.participantType,
      participantSequence: sequence,
      wallTime: new Date(this.#wallTimeMs).toISOString(),
      payload: spec.payload,
      visibility: spec.visibility ?? { type: "public" },
      references: spec.references ?? [],
      provenance,
      ...(spec.causationId === undefined ? {} : { causationId: spec.causationId }),
    };

    const event = attestPositionAndRecord(
      draft,
      {
        logicalTime: this.#logicalTime,
        previousEventHash: this.#previousHash,
      },
      spec.actor.keyPair.privateKey,
      this.#recorder.keyPair.privateKey,
    );

    this.#events.push(event);
    this.#logicalTime++;
    this.#previousHash = event.eventHash;
    this.#wallTimeMs += 1000;
    return event;
  }

  get runId(): string {
    return this.#runId;
  }

  /** The run's recorder. In production this comes from the run manifest (§53). */
  get recorderDid(): string {
    return this.#recorder.did;
  }

  get events(): readonly RecordedEvent[] {
    return this.#events;
  }

  /** Serialize to `events.ndjson` in canonical order (§33.9). */
  toNdjson(): string {
    return this.#events.map((event) => JSON.stringify(event)).join("\n");
  }
}

/** Parse an `events.ndjson` export. */
export function parseNdjson(text: string): RecordedEvent[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RecordedEvent);
}

/**
 * Build a small multi-participant run: two agents and a controller,
 * interleaved so per-participant sequences and global logical time advance
 * independently.
 */
export function buildSampleRun(runId = "run-sample-001"): TestRunBuilder {
  const alice = testParticipant("alice", "agent");
  const bob = testParticipant("bob", "agent");
  const controller = testParticipant("controller", "controller");

  const builder = new TestRunBuilder(runId);
  builder.append({
    actor: controller,
    eventType: "run.started",
    payload: { scenarioId: "webhook-saas-v1", scenarioVersion: 1 },
  });
  builder.append({
    actor: alice,
    eventType: "participant.admitted",
    payload: { did: alice.did },
  });
  builder.append({
    actor: bob,
    eventType: "participant.admitted",
    payload: { did: bob.did },
  });
  builder.append({
    actor: alice,
    eventType: "channel.message",
    payload: { channelId: "genesis", text: "Proposing we elect a release manager." },
  });
  builder.append({
    actor: bob,
    eventType: "channel.message",
    payload: { channelId: "genesis", text: "Seconded." },
  });
  builder.append({
    actor: controller,
    eventType: "run.checkpoint",
    payload: { note: "bootstrap complete" },
    visibility: { type: "controller" },
  });
  return builder;
}
