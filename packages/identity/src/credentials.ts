/**
 * Credentials: human roots and agent creation.
 *
 * Every parent–child relationship is signed (§11.3), and every terminal human
 * identity holds an accepted human-root credential (§11.2). Together these are the
 * edges and the anchor of the provenance graph.
 *
 * Note §11.5: creation provenance, instruction provenance, and operational control
 * are distinct. `relationship` records which kind of edge this is, so a report can
 * distinguish "who introduced this lineage" from "who is driving it right now" —
 * conflating them would corrupt every claim about autonomy.
 *
 * Spec: §11.2, §11.3, §11.5.
 */
import {
  hashCanonical,
  signPayload,
  verifyPayloadWithDid,
  type Digest,
  type PolicyExpression,
} from "@freeq-foundry/protocol";
import type { KeyObject } from "node:crypto";

/** How a human root was established (§11.2). */
export type HumanVerificationMethod =
  | "controller_issued"
  | "trusted_invitation"
  | "passkey_bound"
  | "verified_developer_account"
  | "event_registration"
  | "organization_issued"
  | "proof_of_personhood"
  | "manual_review";

/**
 * §11.2.
 *
 * The prototype may use controller-issued credentials. A public run should support
 * several methods **without requiring public legal names** — pseudonymity is
 * explicitly supported (§11.8), and a verification method that broke it would
 * violate the §46 privacy posture.
 */
export interface HumanRootCredential {
  readonly id: string;
  readonly type: "FreeqHumanRootCredential";
  readonly subjectDid: string;
  readonly issuerDid: string;
  readonly verificationMethod: HumanVerificationMethod;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly statusRef?: string;
  readonly issuerSignature: string;
}

export type CreationRelationship =
  | "created"
  | "commissioned"
  | "spawned"
  | "delegated"
  | "operated";

/** §11.3. Every parent–child edge in the lineage graph. */
export interface AgentCreationCredential {
  readonly id: string;
  readonly type: "FreeqAgentCreationCredential";
  readonly parentDid: string;
  readonly childDid: string;
  readonly relationship: CreationRelationship;
  readonly purpose?: readonly string[];
  readonly constraints?: readonly PolicyExpression[];
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly revocable: boolean;
  /** Whether the child may create further descendants (§11.6). */
  readonly redelegable: boolean;
  readonly parentSignature: string;
}

export type SignedCredential = HumanRootCredential | AgentCreationCredential;

export function isHumanRoot(credential: SignedCredential): credential is HumanRootCredential {
  return credential.type === "FreeqHumanRootCredential";
}

export function isAgentCreation(
  credential: SignedCredential,
): credential is AgentCreationCredential {
  return credential.type === "FreeqAgentCreationCredential";
}

/** The view that gets signed: everything but the signature. */
function humanRootView(credential: HumanRootCredential): Record<string, unknown> {
  const { issuerSignature: _omitted, ...rest } = credential;
  return rest;
}

function agentCreationView(credential: AgentCreationCredential): Record<string, unknown> {
  const { parentSignature: _omitted, ...rest } = credential;
  return rest;
}

export interface IssueHumanRootOptions {
  readonly id: string;
  readonly subjectDid: string;
  readonly issuerDid: string;
  readonly issuerPrivateKey: KeyObject;
  readonly verificationMethod: HumanVerificationMethod;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly statusRef?: string;
}

export function issueHumanRootCredential(
  options: IssueHumanRootOptions,
): HumanRootCredential {
  const unsigned = {
    id: options.id,
    type: "FreeqHumanRootCredential" as const,
    subjectDid: options.subjectDid,
    issuerDid: options.issuerDid,
    verificationMethod: options.verificationMethod,
    issuedAt: options.issuedAt,
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    ...(options.statusRef === undefined ? {} : { statusRef: options.statusRef }),
  };
  return {
    ...unsigned,
    issuerSignature: signPayload(
      "HUMAN_ROOT",
      unsigned as never,
      options.issuerPrivateKey,
    ),
  };
}

export interface IssueCreationOptions {
  readonly id: string;
  readonly parentDid: string;
  readonly childDid: string;
  readonly parentPrivateKey: KeyObject;
  readonly relationship: CreationRelationship;
  readonly issuedAt: string;
  readonly expiresAt?: string;
  readonly purpose?: readonly string[];
  readonly constraints?: readonly PolicyExpression[];
  readonly revocable?: boolean;
  readonly redelegable?: boolean;
}

export function issueAgentCreationCredential(
  options: IssueCreationOptions,
): AgentCreationCredential {
  const unsigned = {
    id: options.id,
    type: "FreeqAgentCreationCredential" as const,
    parentDid: options.parentDid,
    childDid: options.childDid,
    relationship: options.relationship,
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
    ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
    issuedAt: options.issuedAt,
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    // Defaults are the restrictive ones. A credential that is accidentally
    // irrevocable or accidentally redelegable is a hole that is hard to close
    // later, so both must be asked for.
    revocable: options.revocable ?? true,
    redelegable: options.redelegable ?? false,
  };
  return {
    ...unsigned,
    parentSignature: signPayload(
      "AGENT_CREATION",
      unsigned as never,
      options.parentPrivateKey,
    ),
  };
}

/** Verify a credential's signature against its issuer's DID. */
export function verifyCredentialSignature(credential: SignedCredential): boolean {
  try {
    if (isHumanRoot(credential)) {
      return verifyPayloadWithDid(
        "HUMAN_ROOT",
        humanRootView(credential) as never,
        credential.issuerSignature,
        credential.issuerDid,
      );
    }
    return verifyPayloadWithDid(
      "AGENT_CREATION",
      agentCreationView(credential) as never,
      credential.parentSignature,
      credential.parentDid,
    );
  } catch {
    // Malformed encoding or an unresolvable DID. Both mean "does not verify",
    // and the caller gets a definite answer rather than an exception to handle.
    return false;
  }
}

/** Stable hash of a credential, for the provenance path (§11.4). */
export function credentialHash(credential: SignedCredential): Digest {
  return hashCanonical(credential as never);
}

export function isExpiredAt(credential: SignedCredential, at: string): boolean {
  if (credential.expiresAt === undefined) return false;
  return Date.parse(at) > Date.parse(credential.expiresAt);
}

export function issuedBefore(credential: SignedCredential, at: string): boolean {
  return Date.parse(credential.issuedAt) <= Date.parse(at);
}
