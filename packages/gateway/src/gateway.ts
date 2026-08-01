/**
 * The Freeq Gateway.
 *
 * The only writer. Every §33.4 rejection is enforced before an event reaches the
 * store, and every accepted event is acknowledged with the position the store
 * assigned.
 *
 * The gateway adds three things the store does not do:
 *
 *   1. **Admission.** The store checks cryptography and ordering; the gateway
 *      checks whether this participant is allowed to act at all (§6.1).
 *   2. **Visibility filtering.** Subscribers see only what their role permits
 *      (§33.7, §6.12). A store read is unfiltered by design.
 *   3. **Idempotent acknowledgement.** A retry after a lost acknowledgement is a
 *      normal occurrence, not an error (§36.9).
 *
 * Spec: §32.2, §33.4, §36.1, §36.9.
 */
import {
  ProtocolError,
  ProtocolErrorCode,
  type AttributedEvent,
  type ParticipantType,
  type RecordedEvent,
  type VisibilityPolicy,
} from "@freeq-foundry/protocol";
import type { EventStore } from "@freeq-foundry/event-store";

/** An admitted participant. */
export interface Admission {
  readonly did: string;
  readonly participantType: ParticipantType;
  readonly admissionCredentialId: string;
  /** Set on suspension (§12.7). Suspended participants cannot act. */
  readonly suspended?: boolean;
}

/**
 * Admission lookup.
 *
 * An interface rather than a concrete registry: Milestone 2 replaces this with
 * credential verification, and the gateway should not need changing when it does.
 */
export interface AdmissionRegistry {
  lookup(runId: string, did: string): Promise<Admission | undefined> | Admission | undefined;
}

/** A fixed in-memory registry, sufficient for Milestone 1 and for tests. */
export class StaticAdmissionRegistry implements AdmissionRegistry {
  readonly #byRun = new Map<string, Map<string, Admission>>();

  admit(runId: string, admission: Admission): void {
    const run = this.#byRun.get(runId) ?? new Map<string, Admission>();
    run.set(admission.did, admission);
    this.#byRun.set(runId, run);
  }

  suspend(runId: string, did: string): void {
    const existing = this.#byRun.get(runId)?.get(did);
    if (existing !== undefined) {
      this.#byRun.get(runId)?.set(did, { ...existing, suspended: true });
    }
  }

  lookup(runId: string, did: string): Admission | undefined {
    return this.#byRun.get(runId)?.get(did);
  }
}

/** Successful submission. */
export interface Acknowledgement {
  readonly accepted: true;
  readonly eventId: string;
  readonly logicalTime: number;
  readonly eventHash: string;
  /**
   * True when this submission duplicated an already-accepted event.
   *
   * The submission still succeeded from the caller's point of view — that is the
   * point of idempotency — but the distinction matters for metrics and for
   * detecting a client stuck in a retry loop.
   */
  readonly duplicate: boolean;
}

/** Rejected submission. Structured and specific enough to act on. */
export interface Rejection {
  readonly accepted: false;
  readonly code: ProtocolErrorCode;
  readonly message: string;
  /** Field at fault, when one applies. */
  readonly path?: string;
  /** What the participant should do about it. */
  readonly remediation?: string;
}

export type SubmitResult = Acknowledgement | Rejection;

/** Who is asking, for visibility filtering. */
export interface Viewer {
  readonly did: string;
  readonly participantType: ParticipantType;
  /** Channels this viewer belongs to (§14.6). */
  readonly channelIds?: readonly string[];
  /** Terminal human roots of this viewer's lineage (§33.7 `lineage`). */
  readonly terminalHumanDids?: readonly string[];
  /** True once the run has ended and reveal policies apply (§33.7). */
  readonly postRun?: boolean;
}

export interface SubscribeOptions {
  readonly fromLogicalTime?: number;
  readonly limit?: number;
}

export interface GatewayOptions {
  readonly store: EventStore;
  readonly admissions: AdmissionRegistry;
  /**
   * Maximum acceptable clock skew for `wallTime`, in milliseconds.
   *
   * `wallTime` is participant-reported and inside the signature, so the gateway
   * cannot correct it — only refuse it. Unbounded skew would let a participant
   * distort the run clock the primary outcome is measured on (ADR-0009).
   */
  readonly maxClockSkewMs?: number;
  /** Injectable clock, so skew tests do not depend on the wall clock. */
  readonly now?: () => number;
}

const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export class Gateway {
  readonly #store: EventStore;
  readonly #admissions: AdmissionRegistry;
  readonly #maxClockSkewMs: number;
  readonly #now: () => number;

  constructor(options: GatewayOptions) {
    this.#store = options.store;
    this.#admissions = options.admissions;
    this.#maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * Submit a participant-attested event.
   *
   * Checks are ordered cheapest-first, and admission precedes cryptography: a
   * suspended participant should be told they are suspended, not that their
   * signature is fine.
   */
  async submit(event: AttributedEvent): Promise<SubmitResult> {
    const shape = this.#checkShape(event);
    if (shape !== undefined) return shape;

    const admission = await this.#admissions.lookup(event.runId, event.actorDid);
    if (admission === undefined) {
      return {
        accepted: false,
        code: ProtocolErrorCode.UNKNOWN_RUN,
        message: `${event.actorDid} is not admitted to run ${event.runId}`,
        path: "/actorDid",
        remediation:
          "Complete admission before submitting events. Unregistered identities cannot act (§6.1).",
      };
    }
    if (admission.suspended === true) {
      return {
        accepted: false,
        code: ProtocolErrorCode.MALFORMED_EVENT,
        message: `${event.actorDid} is suspended`,
        path: "/actorDid",
        remediation: "A suspended participant cannot act until reinstated (§12.7).",
      };
    }
    if (admission.participantType !== event.participantType) {
      return {
        accepted: false,
        code: ProtocolErrorCode.MALFORMED_EVENT,
        message:
          `participantType ${event.participantType} does not match admitted type ` +
          `${admission.participantType}`,
        path: "/participantType",
        remediation: "Use the participant type recorded at admission.",
      };
    }
    if (event.provenance.admissionCredentialId !== admission.admissionCredentialId) {
      return {
        accepted: false,
        code: ProtocolErrorCode.MALFORMED_EVENT,
        message: "provenance.admissionCredentialId does not match the active admission",
        path: "/provenance/admissionCredentialId",
        remediation:
          "Cite the credential issued at admission. Attribution requires it (§6.4).",
      };
    }

    const result = await this.#store.append(event);
    if (result.accepted) {
      return {
        accepted: true,
        eventId: result.event.eventId,
        logicalTime: result.event.logicalTime,
        eventHash: result.event.eventHash,
        duplicate: false,
      };
    }

    // §36.9: a retry after a lost acknowledgement must be answerable. The
    // store's duplicate rejection carries the stored event, so we can reply with
    // the original position rather than failing a harmless retry.
    if (
      result.code === ProtocolErrorCode.DUPLICATE_EVENT_ID &&
      result.existing !== undefined
    ) {
      return {
        accepted: true,
        eventId: result.existing.eventId,
        logicalTime: result.existing.logicalTime,
        eventHash: result.existing.eventHash,
        duplicate: true,
      };
    }

    return {
      accepted: false,
      code: result.code,
      message: result.message,
      ...(remediationFor(result.code) === undefined
        ? {}
        : { remediation: remediationFor(result.code) as string }),
    };
  }

  /** Highest accepted sequence for a participant, so a client can resynchronize. */
  async sequenceFor(runId: string, did: string): Promise<number> {
    return this.#store.sequenceFor(runId, did);
  }

  /**
   * Stream a run's events, filtered to what the viewer may see.
   *
   * Filtering happens here rather than in the store because visibility is a
   * question about the asker, and the store has no notion of one.
   */
  async *subscribe(
    runId: string,
    viewer: Viewer,
    options: SubscribeOptions = {},
  ): AsyncIterable<RecordedEvent> {
    let yielded = 0;
    const readOptions =
      options.fromLogicalTime === undefined
        ? {}
        : { fromLogicalTime: options.fromLogicalTime };

    for await (const event of this.#store.read(runId, readOptions)) {
      if (!canSee(event.visibility, viewer, event)) continue;
      yield event;
      yielded++;
      if (options.limit !== undefined && yielded >= options.limit) return;
    }
  }

  #checkShape(event: AttributedEvent): Rejection | undefined {
    if (typeof event.eventId !== "string" || event.eventId.length === 0) {
      return malformed("eventId must be a non-empty string", "/eventId");
    }
    if (typeof event.runId !== "string" || event.runId.length === 0) {
      return malformed("runId must be a non-empty string", "/runId");
    }
    if (typeof event.signature !== "string" || event.signature.length === 0) {
      return {
        accepted: false,
        code: ProtocolErrorCode.MISSING_SIGNATURE,
        message: "event carries no content attestation",
        path: "/signature",
        remediation: "Sign the content view with the actor's key before submitting.",
      };
    }
    if (
      !Number.isSafeInteger(event.participantSequence) ||
      event.participantSequence < 1
    ) {
      return malformed(
        `participantSequence must be a positive safe integer, received ${event.participantSequence}`,
        "/participantSequence",
      );
    }

    // A client that could set position could place itself in history. The schema
    // forbids these fields; the gateway refuses them explicitly so the error
    // says what is actually wrong.
    for (const forbidden of [
      "logicalTime",
      "previousEventHash",
      "eventHash",
      "recorderSignature",
    ]) {
      if (forbidden in (event as unknown as Record<string, unknown>)) {
        return malformed(
          `submissions must not carry ${forbidden}; the recorder assigns it (ADR-0008)`,
          `/${forbidden}`,
        );
      }
    }

    const wallTime = Date.parse(event.wallTime);
    if (Number.isNaN(wallTime)) {
      return malformed("wallTime must be an ISO 8601 timestamp", "/wallTime");
    }
    const skew = Math.abs(this.#now() - wallTime);
    if (skew > this.#maxClockSkewMs) {
      return {
        accepted: false,
        code: ProtocolErrorCode.MALFORMED_EVENT,
        message: `wallTime is ${Math.round(skew / 1000)}s from gateway time, limit is ${Math.round(this.#maxClockSkewMs / 1000)}s`,
        path: "/wallTime",
        remediation:
          "Synchronize the agent clock. wallTime is inside the signature, so the gateway cannot correct it, and unbounded skew distorts the run clock (ADR-0009).",
      };
    }

    return undefined;
  }
}

function malformed(message: string, path: string): Rejection {
  return {
    accepted: false,
    code: ProtocolErrorCode.MALFORMED_EVENT,
    message,
    path,
  };
}

/**
 * Visibility check (§33.7).
 *
 * Default-deny: an unrecognized policy hides the event. Failing open here would
 * leak controller-only material the first time a new policy type shipped.
 */
export function canSee(
  policy: VisibilityPolicy,
  viewer: Viewer,
  event: Pick<RecordedEvent, "actorDid" | "provenance">,
): boolean {
  // The controller sees everything. It already holds the recorder key, so
  // withholding events from it would be theatre.
  if (viewer.participantType === "controller") return true;

  // A participant always sees its own events, whatever the policy. Otherwise an
  // agent could not audit its own history.
  if (event.actorDid === viewer.did) return true;

  switch (policy.type) {
    case "public":
      return true;
    case "channel":
      return (viewer.channelIds ?? []).includes(policy.channelId);
    case "participants":
      return policy.participantDids.includes(viewer.did);
    case "lineage":
      return (viewer.terminalHumanDids ?? []).includes(policy.terminalHumanDid);
    case "controller":
      return false;
    case "post_run_reveal":
      return viewer.postRun === true;
    default:
      return false;
  }
}

function remediationFor(code: ProtocolErrorCode): string | undefined {
  switch (code) {
    case ProtocolErrorCode.STALE_SEQUENCE:
      return "This sequence number was already accepted. Fetch the current sequence and resubmit with the next one.";
    case ProtocolErrorCode.GAPPED_SEQUENCE:
      return "A sequence number was skipped, so events may have been lost. Fetch the current sequence and resubmit from there.";
    case ProtocolErrorCode.INVALID_SIGNATURE:
      return "The content attestation does not verify under actorDid. Check that the signing key matches the DID and that the payload was not modified after signing.";
    case ProtocolErrorCode.SIZE_EXCEEDED:
      return "Store large content as an artifact and reference it by hash (§35.4).";
    case ProtocolErrorCode.NON_INTEGER_NUMBER:
      return "Encode non-integer values as strings with a documented unit (ADR-0004).";
    case ProtocolErrorCode.UNEXPECTED_NULL:
      return "Omit the field rather than sending null (ADR-0004).";
    case ProtocolErrorCode.RUN_CLOSED:
      return "This run no longer accepts events.";
    case ProtocolErrorCode.UNKNOWN_RUN:
      return "Check the runId, and complete admission if you have not.";
    default:
      return undefined;
  }
}

export { ProtocolError };
