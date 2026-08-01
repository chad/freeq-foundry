/**
 * Event writer: attests, submits, and advances the simulated clock.
 *
 * A thin helper so the controller never constructs a draft event by hand. Its one
 * real responsibility is per-participant sequence tracking — the gateway rejects a
 * gap or a replay, so the writer must be the single place sequences are assigned.
 */
import {
  attestEvent,
  type DraftEvent,
  type KeyPair,
  type ParticipantType,
} from "@freeq-foundry/protocol";
import type { Gateway } from "@freeq-foundry/gateway";

export interface EventWriterOptions {
  readonly gateway: Gateway;
  readonly runId: string;
  readonly startWallTimeMs: number;
  /**
   * Called after each accepted append.
   *
   * Lets an observer see a run live. Deliberately fire-and-forget and never awaited: a
   * slow or broken observer must not be able to stall or fail the run it is watching.
   */
  readonly onAppended?: (eventId: string, logicalTime: number) => void;
}

interface Registration {
  readonly keyPair: KeyPair;
  readonly participantType: ParticipantType;
  readonly admissionCredentialId: string;
}

export class EventWriter {
  readonly #options: EventWriterOptions;
  readonly #gateway: Gateway;
  readonly #runId: string;
  readonly #registrations = new Map<string, Registration>();
  readonly #sequences = new Map<string, number>();
  #eventIndex = 0;
  #wallTimeMs: number;

  constructor(options: EventWriterOptions) {
    this.#options = options;
    this.#gateway = options.gateway;
    this.#runId = options.runId;
    this.#wallTimeMs = options.startWallTimeMs;
  }

  register(
    keyPair: KeyPair,
    participantType: ParticipantType,
    admissionCredentialId: string,
  ): void {
    this.#registrations.set(keyPair.did, {
      keyPair,
      participantType,
      admissionCredentialId,
    });
  }

  /** Advance the simulated clock. The run clock is derived from these timestamps. */
  advanceClock(byMs: number): void {
    this.#wallTimeMs += byMs;
  }

  get wallTimeMs(): number {
    return this.#wallTimeMs;
  }

  /**
   * Attest and submit an event.
   *
   * Throws on rejection. A controller that cannot write its own events has a bug,
   * not a condition to handle — swallowing the failure would produce a run whose
   * log silently omits what happened.
   */
  async append(actorDid: string, eventType: string, payload: unknown): Promise<void> {
    const registration = this.#registrations.get(actorDid);
    if (registration === undefined) {
      throw new Error(`cannot write for unregistered participant ${actorDid}`);
    }

    const sequence = (this.#sequences.get(actorDid) ?? 0) + 1;
    this.#sequences.set(actorDid, sequence);

    const draft: DraftEvent = {
      eventId: `${this.#runId}-${String(this.#eventIndex).padStart(6, "0")}`,
      runId: this.#runId,
      eventType,
      schemaVersion: 1,
      actorDid,
      participantType: registration.participantType,
      participantSequence: sequence,
      wallTime: new Date(this.#wallTimeMs).toISOString(),
      payload,
      visibility: { type: "public" },
      references: [],
      provenance: {
        signerDid: actorDid,
        terminalHumanDids: [actorDid],
        provenancePathHashes: [],
        admissionCredentialId: registration.admissionCredentialId,
        directInstructionEventIds: [],
        governanceAuthorizationIds: [],
        capabilityGrantIds: [],
      },
    };

    const result = await this.#gateway.submit(
      attestEvent(draft, registration.keyPair.privateKey),
    );
    if (!result.accepted) {
      throw new Error(
        `gateway rejected ${eventType} from ${actorDid}: ${result.code} ${result.message}`,
      );
    }
    this.#eventIndex++;
    try {
      this.#options.onAppended?.(draft.eventId, result.logicalTime);
    } catch {
      // An observer that throws is the observer's problem, not the run's.
    }
  }
}
