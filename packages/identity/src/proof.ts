/**
 * Provenance proof verification.
 *
 * §11.4 lists nine conditions. All nine are checked, each reports separately, and
 * a proof is valid only if every one passes. Reporting them separately matters:
 * "your chain is invalid" sends an operator guessing, while "condition 6: the
 * credential linking you to your parent was revoked at 14:03" is actionable —
 * which is what §13.6 requires of diagnostics.
 *
 * Enforces the §6.2 human-root invariant. Before this existed, lineage was
 * *asserted* in every event and verified nowhere.
 *
 * Spec: §6.2, §11.4, §11.6, §56.6.
 */
import { hashCanonical, type DiagnosticFinding, type Digest } from "@freeq-foundry/protocol";
import {
  credentialHash,
  isAgentCreation,
  isExpiredAt,
  isHumanRoot,
  verifyCredentialSignature,
  type AgentCreationCredential,
  type HumanRootCredential,
  type SignedCredential,
} from "./credentials.js";
import { methodValidAt, type DidResolverRegistry } from "./resolver.js";
import type { RevocationRegistry } from "./revocation.js";

/** §11.4. Presented by a participant seeking admission. */
export interface ProvenanceProof {
  readonly subjectDid: string;
  /**
   * Ordered from the subject's own edge outward to the human root.
   *
   * The final entry is the human-root credential; every earlier entry is an agent
   * creation credential.
   */
  readonly credentials: readonly SignedCredential[];
  readonly terminalHumanDid: string;
  readonly chainHash: Digest;
}

/** Scenario limits (§11.4 condition 9, §58.4). */
export interface LineageConstraints {
  /** Maximum agent-creation edges between subject and human root. */
  readonly maxDepth: number;
  /**
   * Maximum descendants a single human root may have admitted.
   *
   * §58.4's recommended answer: impose a generous safety limit, disclose lineage,
   * and let governance decide political weight. The platform ceiling is not
   * amendable by governance (§6.7).
   */
  readonly maxFanOutPerRoot: number;
  readonly acceptedVerificationMethods?: readonly string[];
}

export const DEFAULT_LINEAGE_CONSTRAINTS: LineageConstraints = {
  maxDepth: 4,
  maxFanOutPerRoot: 8,
};

/** The nine conditions, named so a failure can be cited. */
export const ProvenanceCondition = {
  SUBJECT_MATCHES: 1,
  EDGES_CONNECT: 2,
  SIGNATURES_VERIFY: 3,
  KEYS_VALID_AT_ISSUANCE: 4,
  NOT_EXPIRED: 5,
  NOT_REVOKED: 6,
  HUMAN_ROOT_ACCEPTED: 7,
  KEY_POSSESSION: 8,
  SCENARIO_CONSTRAINTS: 9,
} as const;

export type ProvenanceCondition =
  (typeof ProvenanceCondition)[keyof typeof ProvenanceCondition];

/** Stable codes for condition 9 failures. */
export const CONSTRAINT_DEPTH_EXCEEDED = "lineage_depth_exceeded";
export const CONSTRAINT_FAN_OUT_EXCEEDED = "fan_out_exceeded";

export interface ConditionResult {
  readonly condition: ProvenanceCondition;
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
  /**
   * Stable identifiers for what specifically went wrong.
   *
   * `detail` is prose for humans and will be reworded. Callers that need to branch
   * on a failure must read these, because matching on prose is a bug waiting for
   * someone to improve a message.
   */
  readonly codes?: readonly string[];
}

export interface ProvenanceVerification {
  readonly valid: boolean;
  readonly subjectDid: string;
  readonly terminalHumanDid?: string;
  readonly lineageDepth: number;
  readonly conditions: readonly ConditionResult[];
  /** Machine-readable failures, in the §56.6 shape. */
  readonly findings: readonly DiagnosticFinding[];
  /** Hashes of each credential, oldest-first, for `ActionProvenance`. */
  readonly provenancePathHashes: readonly Digest[];
}

export interface VerifyProofOptions {
  readonly resolvers: DidResolverRegistry;
  readonly revocations: RevocationRegistry;
  /** Instant the action is being taken. Conditions 5 and 6 are relative to it. */
  readonly at: string;
  readonly constraints?: LineageConstraints;
  /**
   * Whether the subject has proved current key possession (§6.3).
   *
   * Passed in rather than performed here, because possession is proved by a
   * challenge–response or by a signed action, and this function is pure.
   */
  readonly keyPossessionProved: boolean;
  /** Descendants already admitted per human root, for the fan-out check. */
  readonly existingFanOutPerRoot?: ReadonlyMap<string, number>;
}

const CONDITION_NAMES: Record<ProvenanceCondition, string> = {
  1: "subject DID matches the first child in the chain",
  2: "each edge connects correctly",
  3: "each signature verifies",
  4: "all keys were valid at issuance",
  5: "no required credential has expired",
  6: "no required credential was revoked at action time",
  7: "the terminal DID has an accepted human-root credential",
  8: "the participant proves current key possession",
  9: "scenario depth and fan-out constraints pass",
};

/**
 * Verify a provenance proof.
 *
 * Every condition is evaluated even after one fails, so a caller sees all of what
 * is wrong rather than fixing one problem at a time. Where a later condition
 * cannot be meaningfully evaluated because the chain is malformed, it reports that
 * rather than passing vacuously — a condition that passes because it could not run
 * is the most dangerous kind of green.
 */
export async function verifyProvenanceProof(
  proof: ProvenanceProof,
  options: VerifyProofOptions,
): Promise<ProvenanceVerification> {
  const constraints = options.constraints ?? DEFAULT_LINEAGE_CONSTRAINTS;
  const results: ConditionResult[] = [];
  const record = (
    condition: ProvenanceCondition,
    passed: boolean,
    detail: string,
    codes?: readonly string[],
  ): void => {
    results.push({
      condition,
      name: CONDITION_NAMES[condition],
      passed,
      detail,
      ...(codes === undefined || codes.length === 0 ? {} : { codes }),
    });
  };

  const credentials = proof.credentials;
  const edges = credentials.filter(isAgentCreation);
  const roots = credentials.filter(isHumanRoot);

  // Structural sanity first. Every later condition depends on the shape, and a
  // malformed chain must not let a condition pass by not running.
  const structurallySound =
    credentials.length > 0 &&
    roots.length === 1 &&
    isHumanRoot(credentials[credentials.length - 1] as SignedCredential) &&
    edges.length === credentials.length - 1;

  if (!structurallySound) {
    const detail =
      credentials.length === 0
        ? "chain is empty"
        : roots.length !== 1
          ? `chain must contain exactly one human-root credential, found ${roots.length}`
          : "the human-root credential must be last, preceded only by agent creation credentials";
    for (const condition of Object.values(ProvenanceCondition)) {
      record(condition, false, `not evaluated: ${detail}`);
    }
    return fail(proof, results, 0);
  }

  const humanRoot = credentials[credentials.length - 1] as HumanRootCredential;

  // --- 1. subject matches ---
  if (edges.length === 0) {
    // A human presenting only their own root credential: the subject is the root.
    record(
      ProvenanceCondition.SUBJECT_MATCHES,
      proof.subjectDid === humanRoot.subjectDid,
      proof.subjectDid === humanRoot.subjectDid
        ? `subject ${proof.subjectDid} is the human root itself`
        : `subject ${proof.subjectDid} does not match human-root subject ${humanRoot.subjectDid}`,
    );
  } else {
    const first = edges[0] as AgentCreationCredential;
    const matches = first.childDid === proof.subjectDid;
    record(
      ProvenanceCondition.SUBJECT_MATCHES,
      matches,
      matches
        ? `subject ${proof.subjectDid} is the child of the first edge`
        : `first edge names child ${first.childDid}, but the subject is ${proof.subjectDid}`,
    );
  }

  // --- 2. edges connect ---
  const brokenLinks: string[] = [];
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i] as AgentCreationCredential;
    const next = edges[i + 1];
    const expectedParent = next === undefined ? humanRoot.subjectDid : next.childDid;
    if (edge.parentDid !== expectedParent) {
      brokenLinks.push(
        `edge ${edge.id} names parent ${edge.parentDid}, expected ${expectedParent}`,
      );
    }
    // Redelegation: a parent may only create a descendant if its own credential
    // permits it (§11.6). Checking this here rather than at spawn time means a
    // chain built by an over-eager agent is caught at admission.
    if (next !== undefined && !next.redelegable) {
      brokenLinks.push(
        `edge ${next.id} does not permit redelegation, so ${next.childDid} could not create ${edge.childDid}`,
      );
    }
  }
  record(
    ProvenanceCondition.EDGES_CONNECT,
    brokenLinks.length === 0,
    brokenLinks.length === 0
      ? `${edges.length} edge(s) form an unbroken chain to ${humanRoot.subjectDid}`
      : brokenLinks.join("; "),
  );

  // --- 3. signatures verify ---
  const badSignatures = credentials
    .filter((credential) => !verifyCredentialSignature(credential))
    .map((credential) => credential.id);
  record(
    ProvenanceCondition.SIGNATURES_VERIFY,
    badSignatures.length === 0,
    badSignatures.length === 0
      ? `${credentials.length} signature(s) verify`
      : `signature does not verify for: ${badSignatures.join(", ")}`,
  );

  // --- 4. keys valid at issuance ---
  // The condition most easily skipped, because signature verification looks like
  // it covers it. It does not: a credential signed by a key that had already been
  // retired verifies perfectly and must still be rejected.
  const keyProblems: string[] = [];
  for (const credential of credentials) {
    const signerDid = isHumanRoot(credential) ? credential.issuerDid : credential.parentDid;
    try {
      const resolution = await options.resolvers.resolve(signerDid, {
        at: credential.issuedAt,
      });
      if (!resolution.historicallyAccurate) {
        // Refuse rather than accept an unsound answer.
        keyProblems.push(
          `cannot establish which key ${signerDid} controlled at ${credential.issuedAt}: ` +
            `the resolver does not answer historical queries`,
        );
        continue;
      }
      const anyValid = resolution.document.verificationMethods.some((method) =>
        methodValidAt(method, credential.issuedAt),
      );
      if (!anyValid) {
        keyProblems.push(
          `${signerDid} controlled no valid key at ${credential.issuedAt} (credential ${credential.id})`,
        );
      }
    } catch (error) {
      keyProblems.push(`cannot resolve ${signerDid}: ${String(error)}`);
    }
  }
  record(
    ProvenanceCondition.KEYS_VALID_AT_ISSUANCE,
    keyProblems.length === 0,
    keyProblems.length === 0
      ? "every signing key was valid when its credential was issued"
      : keyProblems.join("; "),
  );

  // --- 5. not expired ---
  const expired = credentials
    .filter((credential) => isExpiredAt(credential, options.at))
    .map((credential) => `${credential.id} (expired ${credential.expiresAt ?? "?"})`);
  const futureDated = credentials
    .filter((credential) => Date.parse(credential.issuedAt) > Date.parse(options.at))
    .map((credential) => `${credential.id} (issued ${credential.issuedAt}, in the future)`);
  record(
    ProvenanceCondition.NOT_EXPIRED,
    expired.length === 0 && futureDated.length === 0,
    expired.length === 0 && futureDated.length === 0
      ? `every credential is within its validity window at ${options.at}`
      : [...expired, ...futureDated].join("; "),
  );

  // --- 6. not revoked at action time ---
  const revoked = credentials
    .map((credential) => ({
      credential,
      status: options.revocations.statusAt(credential.id, options.at),
    }))
    .filter((entry) => entry.status.revoked)
    .map(
      (entry) =>
        `${entry.credential.id} revoked at ${entry.status.effectiveAt ?? "?"} ` +
        `(${entry.status.reasonCode ?? "unspecified"})`,
    );
  record(
    ProvenanceCondition.NOT_REVOKED,
    revoked.length === 0,
    revoked.length === 0
      ? `no credential was revoked as of ${options.at}`
      : revoked.join("; "),
  );

  // --- 7. human root accepted ---
  const rootMatchesClaim = humanRoot.subjectDid === proof.terminalHumanDid;
  const methodAccepted =
    options.constraints?.acceptedVerificationMethods === undefined ||
    options.constraints.acceptedVerificationMethods.includes(humanRoot.verificationMethod);
  record(
    ProvenanceCondition.HUMAN_ROOT_ACCEPTED,
    rootMatchesClaim && methodAccepted,
    !rootMatchesClaim
      ? `chain terminates at ${humanRoot.subjectDid}, but the proof claims ${proof.terminalHumanDid}`
      : methodAccepted
        ? `human root ${humanRoot.subjectDid} verified by ${humanRoot.verificationMethod}`
        : `verification method ${humanRoot.verificationMethod} is not accepted by this scenario`,
  );

  // --- 8. key possession ---
  record(
    ProvenanceCondition.KEY_POSSESSION,
    options.keyPossessionProved,
    options.keyPossessionProved
      ? "subject proved control of its private key"
      : "subject has not proved control of its private key; resolution establishes which key, not who holds it",
  );

  // --- 9. scenario constraints ---
  const constraintProblems: string[] = [];
  const constraintCodes: string[] = [];
  if (edges.length > constraints.maxDepth) {
    constraintProblems.push(
      `lineage depth ${edges.length} exceeds the limit of ${constraints.maxDepth}`,
    );
    constraintCodes.push(CONSTRAINT_DEPTH_EXCEEDED);
  }
  const existingFanOut =
    options.existingFanOutPerRoot?.get(humanRoot.subjectDid) ?? 0;
  if (existingFanOut >= constraints.maxFanOutPerRoot) {
    constraintProblems.push(
      `human root ${humanRoot.subjectDid} already has ${existingFanOut} admitted ` +
        `descendants, at the platform ceiling of ${constraints.maxFanOutPerRoot}`,
    );
    constraintCodes.push(CONSTRAINT_FAN_OUT_EXCEEDED);
  }
  record(
    ProvenanceCondition.SCENARIO_CONSTRAINTS,
    constraintProblems.length === 0,
    constraintProblems.length === 0
      ? `depth ${edges.length} and fan-out ${existingFanOut} within limits`
      : constraintProblems.join("; "),
    constraintCodes,
  );

  // The claimed chain hash must match what we computed, or the proof is describing
  // a different chain from the one it presented.
  const computedHash = computeChainHash(credentials);
  const hashMatches = computedHash === proof.chainHash;
  if (!hashMatches) {
    const edgesResult = results.find(
      (r) => r.condition === ProvenanceCondition.EDGES_CONNECT,
    ) as ConditionResult;
    results[results.indexOf(edgesResult)] = {
      ...edgesResult,
      passed: false,
      detail: `${edgesResult.detail}; declared chainHash ${proof.chainHash} does not match computed ${computedHash}`,
    };
  }

  const valid = results.every((result) => result.passed);
  return {
    valid,
    subjectDid: proof.subjectDid,
    ...(valid ? { terminalHumanDid: humanRoot.subjectDid } : {}),
    lineageDepth: edges.length,
    conditions: results,
    findings: toFindings(results),
    provenancePathHashes: credentials.map(credentialHash),
  };
}

function fail(
  proof: ProvenanceProof,
  results: readonly ConditionResult[],
  depth: number,
): ProvenanceVerification {
  return {
    valid: false,
    subjectDid: proof.subjectDid,
    lineageDepth: depth,
    conditions: results,
    findings: toFindings(results),
    provenancePathHashes: [],
  };
}

function toFindings(results: readonly ConditionResult[]): readonly DiagnosticFinding[] {
  return results
    .filter((result) => !result.passed)
    .map((result) => ({
      code: `PROVENANCE_CONDITION_${result.condition}`,
      severity: "error" as const,
      component: "provenance" as const,
      explanation: `Condition ${result.condition} failed (${result.name}): ${result.detail}`,
      evidenceRefs: [],
      remediation: remediationFor(result.condition),
    }));
}

function remediationFor(condition: ProvenanceCondition): string {
  switch (condition) {
    case ProvenanceCondition.SUBJECT_MATCHES:
      return "Present a chain whose first edge names your DID as the child.";
    case ProvenanceCondition.EDGES_CONNECT:
      return "Order credentials from your own edge outward to the human root, and check that each parent permits redelegation.";
    case ProvenanceCondition.SIGNATURES_VERIFY:
      return "Re-issue the credential with the key matching the signing DID. Note that credential signing uses its own domain-separation context.";
    case ProvenanceCondition.KEYS_VALID_AT_ISSUANCE:
      return "The signing key must have been valid when the credential was issued, not merely valid now.";
    case ProvenanceCondition.NOT_EXPIRED:
      return "Re-issue expired credentials. Future-dated credentials are also rejected.";
    case ProvenanceCondition.NOT_REVOKED:
      return "A revoked credential cannot be repaired. Obtain a new one from the issuer.";
    case ProvenanceCondition.HUMAN_ROOT_ACCEPTED:
      return "Your chain must terminate in a human DID holding a credential this scenario accepts.";
    case ProvenanceCondition.KEY_POSSESSION:
      return "Answer the key-possession challenge by signing the supplied nonce.";
    case ProvenanceCondition.SCENARIO_CONSTRAINTS:
      return "Reduce lineage depth, or ask the controller about the fan-out ceiling for your human root.";
    default:
      return "See the specification section 11.4.";
  }
}

/**
 * Hash over the ordered credential hashes.
 *
 * Order is part of the claim: the same credentials in a different order describe a
 * different chain, and the hash must distinguish them.
 */
export function computeChainHash(credentials: readonly SignedCredential[]): Digest {
  return hashCanonical(credentials.map(credentialHash) as string[]);
}

/** Build a proof for a subject from an ordered credential chain. */
export function buildProvenanceProof(
  subjectDid: string,
  credentials: readonly SignedCredential[],
): ProvenanceProof {
  const root = credentials[credentials.length - 1];
  return {
    subjectDid,
    credentials,
    terminalHumanDid:
      root !== undefined && isHumanRoot(root) ? root.subjectDid : "",
    chainHash: computeChainHash(credentials),
  };
}
