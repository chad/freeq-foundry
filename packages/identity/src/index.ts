/**
 * @freeq-foundry/identity
 *
 * Enforces §6.2 (human-root) and §6.3 (key possession). Before this package,
 * lineage was recorded in every event and verified nowhere.
 */
export {
  DidWebResolver,
  didWebToUrl,
  exampleDidDocument,
  parseDidDocument,
  type CachedResolution,
  type DidWebOptions,
} from "./didweb.js";

export {
  DidKeyResolver,
  DidResolverRegistry,
  defaultResolvers,
  resolversWithWeb,
  methodValidAt,
  type DidDocument,
  type DidResolution,
  type DidResolver,
  type ResolutionTime,
  type VerificationMethod,
} from "./resolver.js";

export {
  credentialHash,
  isAgentCreation,
  isExpiredAt,
  isHumanRoot,
  issueAgentCreationCredential,
  issueHumanRootCredential,
  issuedBefore,
  verifyCredentialSignature,
  type AgentCreationCredential,
  type CreationRelationship,
  type HumanRootCredential,
  type HumanVerificationMethod,
  type IssueCreationOptions,
  type IssueHumanRootOptions,
  type SignedCredential,
} from "./credentials.js";

export {
  CONSTRAINT_DEPTH_EXCEEDED,
  CONSTRAINT_FAN_OUT_EXCEEDED,
  DEFAULT_LINEAGE_CONSTRAINTS,
  ProvenanceCondition,
  buildProvenanceProof,
  computeChainHash,
  verifyProvenanceProof,
  type ConditionResult,
  type LineageConstraints,
  type ProvenanceProof,
  type ProvenanceVerification,
  type VerifyProofOptions,
} from "./proof.js";

export {
  RevocationRegistry,
  computeBlastRadius,
  signRevocation,
  verifyRevocationSignature,
  type BlastRadius,
  type CredentialRevocation,
  type RevocationReason,
  type RevocationStatus,
} from "./revocation.js";

export {
  ChallengeRegistry,
  createChallenge,
  respondToChallenge,
  verifyChallengeResponse,
  type Challenge,
  type ChallengeResponse,
  type ChallengeVerification,
} from "./challenge.js";

export {
  AdmissionService,
  DEFAULT_LINEAGE_VISIBILITY,
  buildLineageGraph,
  describeLineage,
  lineagePseudonym,
  sharesRootWith,
  type AdmissionGrant,
  type AdmissionOutcome,
  type AdmissionRefusal,
  type AdmissionRejectionReason,
  type AdmissionServiceOptions,
  type LineageGraph,
  type LineageNode,
  type LineageVisibility,
} from "./lineage.js";
