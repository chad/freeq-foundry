/**
 * The signed Foundry event log, kept alongside the channel.
 *
 * The channel is legible; this is verifiable. §6.9 requires authoritative state to be
 * reconstructable, and a chat transcript is not a hash chain — it can be edited, it has
 * no per-participant sequence, and nothing in it is signed by the actor.
 *
 * So every agent action lands twice: once as a coordination event a human can read, and
 * once here as a `RecordedEvent` with both attestations (ADR-0008). If the two ever
 * disagree, this one is the record.
 *
 * The recorder key is held by the launcher, not by the agents — §32.3 places each
 * participant outside the platform's trust boundary, and an agent that could sign its
 * own position could reorder history.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  GENESIS_HASH,
  attestEvent,
  positionEvent,
  recordEvent,
  verifyChain,
  type ChainVerification,
  type Digest,
  type KeyPair,
  type RecordedEvent,
} from "@freeq-foundry/protocol";

export interface FoundryLogOptions {
  readonly runId: string;
  readonly path: string;
  readonly recorder: KeyPair;
  /** Signing key per participant DID, so each agent attests its own content. */
  readonly signers: ReadonlyMap<string, KeyPair>;
}

export class FoundryLog {
  readonly #options: FoundryLogOptions;
  readonly #events: RecordedEvent[] = [];
  readonly #sequences = new Map<string, number>();
  #previous: Digest = GENESIS_HASH;
  #logicalTime = 0;

  constructor(options: FoundryLogOptions) {
    this.#options = options;
    mkdirSync(dirname(options.path), { recursive: true });
  }

  get events(): readonly RecordedEvent[] {
    return this.#events;
  }

  /** Register an agent's signing key once its identity exists. */
  addSigner(did: string, keyPair: KeyPair): void {
    (this.#options.signers as Map<string, KeyPair>).set(did, keyPair);
  }

  /**
   * Record an event.
   *
   * Synchronous and appended immediately: an agent can be killed mid-turn, and a log
   * buffered in memory is a log that loses the last thing that happened — which is
   * usually the interesting thing.
   */
  record(actorDid: string, eventType: string, payload: unknown): RecordedEvent | undefined {
    const signer = this.#options.signers.get(actorDid);
    if (signer === undefined) return undefined;

    // Allocate but do NOT commit: the sequence is part of the signed content, so it has
    // to exist before signing — but committing it before the event is safely appended
    // burns the number if canonicalization throws, and a burnt number reads as a lost
    // event forever (GAPPED_SEQUENCE). A live run produced thirty of these.
    const sequence = (this.#sequences.get(actorDid) ?? 0) + 1;

    let recorded: RecordedEvent;
    try {
      recorded = this.#build(actorDid, eventType, sanitizePayload(payload), sequence, signer);
    } catch (error) {
      // Payloads originate with language models, so "un-canonicalizable" is a normal
      // input, not an exceptional one. Record the failure in place of the payload so
      // the chain stays gapless and the problem stays visible.
      try {
        recorded = this.#build(
          actorDid,
          eventType,
          { canonicalizationFailed: String(error).slice(0, 300) },
          sequence,
          signer,
        );
      } catch {
        // Cannot record anything for this actor; leave the sequence unconsumed.
        return undefined;
      }
    }

    this.#sequences.set(actorDid, sequence);
    this.#events.push(recorded);
    this.#logicalTime++;
    this.#previous = recorded.eventHash;
    appendFileSync(this.#options.path, `${JSON.stringify(recorded)}\n`, "utf8");
    return recorded;
  }

  #build(
    actorDid: string,
    eventType: string,
    payload: unknown,
    sequence: number,
    signer: KeyPair,
  ): RecordedEvent {
    const attested = attestEvent(
      {
        eventId: `${this.#options.runId}-${String(this.#logicalTime).padStart(6, "0")}`,
        runId: this.#options.runId,
        eventType,
        schemaVersion: 1,
        actorDid,
        participantType: "agent",
        participantSequence: sequence,
        wallTime: new Date().toISOString(),
        payload,
        visibility: { type: "public" },
        references: [],
        provenance: {
          signerDid: actorDid,
          terminalHumanDids: [],
          provenancePathHashes: [],
          admissionCredentialId: `freeq-delegation-${actorDid.slice(-8)}`,
          directInstructionEventIds: [],
          governanceAuthorizationIds: [],
          capabilityGrantIds: [],
        },
      },
      signer.privateKey,
    );

    return recordEvent(
      positionEvent(attested, {
        logicalTime: this.#logicalTime,
        previousEventHash: this.#previous,
      }),
      this.#options.recorder.privateKey,
    );
  }

  verify(): ChainVerification {
    return verifyChain(this.#events, {
      runId: this.#options.runId,
      recorderDid: this.#options.recorder.did,
    });
  }
}

const MAX_STRING = 8_192;
const MAX_ARRAY = 256;
const MAX_DEPTH = 12;

/**
 * Make a model-supplied payload safe to canonicalize.
 *
 * Canonical serialization rejects non-finite numbers, unsupported types, and anything
 * over the size ceiling — all of which a language model can produce. `JSON.parse` turns
 * the literal `1e400` into `Infinity`, and an agent discussing valuations writes large
 * numbers all day. Coercing here keeps the offending value visible in the log instead of
 * throwing the event away.
 */
function sanitizePayload(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated: nesting too deep]";
  if (value === null) return null;

  switch (typeof value) {
    case "number":
      return Number.isFinite(value) ? value : `[non-finite: ${String(value)}]`;
    case "string":
      return value.length <= MAX_STRING
        ? value
        : `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING} chars]`;
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "undefined":
      return null;
    case "object":
      break;
    default:
      return `[unsupported: ${typeof value}]`;
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((item) => sanitizePayload(item, depth + 1));
    return value.length > MAX_ARRAY ? [...items, `[truncated ${value.length - MAX_ARRAY} items]`] : items;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = sanitizePayload(item, depth + 1);
  }
  return out;
}
