/**
 * Key-possession challenge.
 *
 * §6.3: every participant MUST prove possession of the private key for its DID.
 * Resolution establishes *which* key; only a signature establishes *who holds it*.
 * Without this, anyone could present a stranger's DID and a valid public chain.
 *
 * Spec: §6.3, §13.5.
 */
import {
  ProtocolError,
  ProtocolErrorCode,
  signPayload,
  verifyPayloadWithDid,
} from "@freeq-foundry/protocol";
import { randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";

export interface Challenge {
  readonly challengeId: string;
  readonly subjectDid: string;
  /** Random, single-use. */
  readonly nonce: string;
  readonly runId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface ChallengeResponse {
  readonly challengeId: string;
  readonly subjectDid: string;
  readonly signature: string;
}

export interface ChallengeOptions {
  readonly subjectDid: string;
  readonly runId: string;
  readonly issuedAt: string;
  /** Validity window. Short by default: a long-lived nonce is a replay window. */
  readonly ttlMs?: number;
  /** Injectable for deterministic tests. */
  readonly nonce?: string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function createChallenge(options: ChallengeOptions): Challenge {
  const issuedMs = Date.parse(options.issuedAt);
  if (Number.isNaN(issuedMs)) {
    throw new ProtocolError(
      ProtocolErrorCode.MALFORMED_EVENT,
      `issuedAt must be an ISO 8601 instant, received ${options.issuedAt}`,
    );
  }
  const nonce = options.nonce ?? randomBytes(32).toString("base64url");
  return {
    challengeId: `chal-${nonce.slice(0, 12)}`,
    subjectDid: options.subjectDid,
    nonce,
    runId: options.runId,
    issuedAt: options.issuedAt,
    expiresAt: new Date(issuedMs + (options.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
  };
}

/** Sign a challenge. The whole challenge is signed, not just the nonce. */
export function respondToChallenge(
  challenge: Challenge,
  privateKey: KeyObject,
): ChallengeResponse {
  return {
    challengeId: challenge.challengeId,
    subjectDid: challenge.subjectDid,
    signature: signPayload("CHALLENGE", challenge as never, privateKey),
  };
}

export interface ChallengeVerification {
  readonly proved: boolean;
  readonly reason: string;
}

/**
 * Verify a response.
 *
 * The whole challenge is the signed payload, so `runId` and `expiresAt` are bound
 * into the signature. A response harvested from one run cannot be replayed into
 * another, and an expired nonce cannot be revived.
 */
export function verifyChallengeResponse(
  challenge: Challenge,
  response: ChallengeResponse,
  at: string,
): ChallengeVerification {
  if (response.challengeId !== challenge.challengeId) {
    return {
      proved: false,
      reason: `response is for challenge ${response.challengeId}, not ${challenge.challengeId}`,
    };
  }
  if (response.subjectDid !== challenge.subjectDid) {
    return {
      proved: false,
      reason: `response claims subject ${response.subjectDid}, challenge was issued to ${challenge.subjectDid}`,
    };
  }
  if (Date.parse(at) > Date.parse(challenge.expiresAt)) {
    return {
      proved: false,
      reason: `challenge expired at ${challenge.expiresAt}; a long-lived nonce is a replay window`,
    };
  }

  try {
    const ok = verifyPayloadWithDid(
      "CHALLENGE",
      challenge as never,
      response.signature,
      challenge.subjectDid,
    );
    return ok
      ? { proved: true, reason: `${challenge.subjectDid} proved control of its key` }
      : {
          proved: false,
          reason: `signature does not verify under ${challenge.subjectDid}`,
        };
  } catch (error) {
    return { proved: false, reason: `malformed response: ${String(error)}` };
  }
}

/**
 * Tracks outstanding challenges, single-use.
 *
 * Consuming on verification is what makes the nonce single-use. Leaving a
 * successful response replayable would defeat the point of a nonce entirely.
 */
export class ChallengeRegistry {
  readonly #open = new Map<string, Challenge>();

  issue(challenge: Challenge): Challenge {
    this.#open.set(challenge.challengeId, challenge);
    return challenge;
  }

  /** Verify and consume. A second attempt with the same response fails. */
  consume(response: ChallengeResponse, at: string): ChallengeVerification {
    const challenge = this.#open.get(response.challengeId);
    if (challenge === undefined) {
      return {
        proved: false,
        reason: `no outstanding challenge ${response.challengeId}; it may already have been used`,
      };
    }
    const verification = verifyChallengeResponse(challenge, response, at);
    if (verification.proved) this.#open.delete(response.challengeId);
    return verification;
  }

  get outstanding(): number {
    return this.#open.size;
  }
}
