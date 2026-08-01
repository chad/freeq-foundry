/**
 * Credential revocation and blast radius.
 *
 * §6.8: revocation MUST NOT erase historical events. A revoked credential does not
 * make past actions unhappen — it makes future actions unauthorized. So revocation
 * is recorded with an effective instant, and status is always asked *as of* a time
 * rather than in the present tense.
 *
 * §11.10: revoking a root suspends its descendants. The blast-radius query exists
 * because an operator about to revoke needs to know what they are about to break,
 * and finding out afterwards is how a run gets ruined.
 *
 * Spec: §6.8, §11.10, §56.5.
 */
import { signPayload, verifyPayloadWithDid } from "@freeq-foundry/protocol";
import type { KeyObject } from "node:crypto";
import type { SignedCredential } from "./credentials.js";
import { isAgentCreation, isHumanRoot } from "./credentials.js";

export type RevocationReason =
  | "key_compromise"
  | "operator_request"
  | "policy_violation"
  | "expired_relationship"
  | "controller_action"
  | "other";

/** §56.5. */
export interface CredentialRevocation {
  readonly credentialId: string;
  readonly revokerDid: string;
  readonly reasonCode: RevocationReason;
  readonly reasonText?: string;
  /** Actions before this instant remain authorized (§6.8). */
  readonly effectiveAt: string;
  readonly signature: string;
}

export interface RevocationStatus {
  readonly revoked: boolean;
  readonly effectiveAt?: string;
  readonly reasonCode?: RevocationReason;
  readonly revokerDid?: string;
}

const NOT_REVOKED: RevocationStatus = { revoked: false };

function revocationView(revocation: CredentialRevocation): Record<string, unknown> {
  const { signature: _omitted, ...rest } = revocation;
  return rest;
}

export function signRevocation(
  revocation: Omit<CredentialRevocation, "signature">,
  revokerPrivateKey: KeyObject,
): CredentialRevocation {
  return {
    ...revocation,
    signature: signPayload("REVOCATION", revocation as never, revokerPrivateKey),
  };
}

export function verifyRevocationSignature(revocation: CredentialRevocation): boolean {
  try {
    return verifyPayloadWithDid(
      "REVOCATION",
      revocationView(revocation) as never,
      revocation.signature,
      revocation.revokerDid,
    );
  } catch {
    return false;
  }
}

/**
 * Tracks revocations and answers status as of an instant.
 *
 * Unsigned revocations are refused. Anyone who could revoke without signing could
 * silently strip authority from a participant, which is an attack rather than an
 * administrative action.
 */
export class RevocationRegistry {
  readonly #byCredentialId = new Map<string, CredentialRevocation>();

  /** Record a revocation. Returns false if the signature does not verify. */
  revoke(revocation: CredentialRevocation): boolean {
    if (!verifyRevocationSignature(revocation)) return false;
    const existing = this.#byCredentialId.get(revocation.credentialId);
    // Keep the earliest effective revocation. A later one cannot un-revoke, and
    // taking the earliest is the conservative reading.
    if (
      existing !== undefined &&
      Date.parse(existing.effectiveAt) <= Date.parse(revocation.effectiveAt)
    ) {
      return true;
    }
    this.#byCredentialId.set(revocation.credentialId, revocation);
    return true;
  }

  /**
   * Status as of an instant.
   *
   * Always time-relative. A credential revoked at 14:03 was valid at 14:02, and
   * every action taken then remains authorized (§6.8).
   */
  statusAt(credentialId: string, at: string): RevocationStatus {
    const revocation = this.#byCredentialId.get(credentialId);
    if (revocation === undefined) return NOT_REVOKED;
    if (Date.parse(at) < Date.parse(revocation.effectiveAt)) return NOT_REVOKED;
    return {
      revoked: true,
      effectiveAt: revocation.effectiveAt,
      reasonCode: revocation.reasonCode,
      revokerDid: revocation.revokerDid,
    };
  }

  get size(): number {
    return this.#byCredentialId.size;
  }

  all(): readonly CredentialRevocation[] {
    return [...this.#byCredentialId.values()];
  }
}

export interface BlastRadius {
  readonly credentialId: string;
  /** DIDs whose provenance breaks. Includes the immediate subject. */
  readonly affectedDids: readonly string[];
  /** Credentials rendered unusable because an ancestor edge is gone. */
  readonly affectedCredentialIds: readonly string[];
  readonly humanRootsAffected: readonly string[];
  readonly explanation: string;
}

/**
 * What breaks if this credential is revoked?
 *
 * Answered *before* revoking, because an operator revoking a root needs to know it
 * is about to suspend eleven agents rather than one. §11.10 requires descendants to
 * be suspended; this makes the consequence visible first.
 */
export function computeBlastRadius(
  credentialId: string,
  credentials: readonly SignedCredential[],
): BlastRadius {
  const target = credentials.find((credential) => credential.id === credentialId);
  if (target === undefined) {
    return {
      credentialId,
      affectedDids: [],
      affectedCredentialIds: [],
      humanRootsAffected: [],
      explanation: `credential ${credentialId} is not present in the supplied set`,
    };
  }

  const edges = credentials.filter(isAgentCreation);
  const affectedDids = new Set<string>();
  const affectedCredentialIds = new Set<string>([credentialId]);
  const roots = new Set<string>();

  if (isHumanRoot(target)) {
    // Revoking a root breaks every lineage anchored to it.
    roots.add(target.subjectDid);
    affectedDids.add(target.subjectDid);
    collectDescendants(target.subjectDid, edges, affectedDids, affectedCredentialIds);
  } else {
    affectedDids.add(target.childDid);
    collectDescendants(target.childDid, edges, affectedDids, affectedCredentialIds);
    for (const root of credentials.filter(isHumanRoot)) {
      if (reaches(target.childDid, root.subjectDid, edges)) roots.add(root.subjectDid);
    }
  }

  const dids = [...affectedDids].sort();
  return {
    credentialId,
    affectedDids: dids,
    affectedCredentialIds: [...affectedCredentialIds].sort(),
    humanRootsAffected: [...roots].sort(),
    explanation:
      dids.length === 1
        ? `revoking ${credentialId} suspends ${dids[0]}`
        : `revoking ${credentialId} suspends ${dids.length} participants, ` +
          `including ${dids.length - 1} descendant(s) whose provenance runs through it`,
  };
}

/** The fields of an agent creation credential the graph walks need. */
interface Edge {
  readonly id: string;
  readonly parentDid: string;
  readonly childDid: string;
}

function collectDescendants(
  did: string,
  edges: readonly Edge[],
  dids: Set<string>,
  credentialIds: Set<string>,
): void {
  // Breadth-first with a seen set: a malformed chain could contain a cycle, and an
  // operator asking "what breaks?" must get an answer rather than a hang.
  const queue = [did];
  const seen = new Set<string>([did]);

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of edges) {
      if (edge.parentDid !== current) continue;
      credentialIds.add(edge.id);
      dids.add(edge.childDid);
      if (!seen.has(edge.childDid)) {
        seen.add(edge.childDid);
        queue.push(edge.childDid);
      }
    }
  }
}

function reaches(fromDid: string, toDid: string, edges: readonly Edge[]): boolean {
  let current = fromDid;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    if (current === toDid) return true;
    const edge = edges.find((candidate) => candidate.childDid === current);
    if (edge === undefined) return false;
    current = edge.parentDid;
  }
  return false;
}
