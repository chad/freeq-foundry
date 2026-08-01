/**
 * @freeq-foundry/governance
 *
 * Implements §6.6: governance affects real state only through structured,
 * validated, authorized actions.
 */
export {
  QUORUM_VOCABULARY,
  decideElection,
  eligibleVoters,
  evaluateQuorum,
  quorumContext,
  tallyProposal,
  type Ballot,
  type Candidate,
  type ElectionMethod,
  type ElectionOutcome,
  type QuorumOutcome,
  type Tally,
  type TieBreak,
  type Voter,
} from "./tally.js";

export {
  emptyOfficeRegistry,
  expiredOffices,
  officeDefinitionsFrom,
  officesHeldBy,
  officesOfSuspended,
  removeFromOffice,
  takeOffice,
  vacantOffices,
  type OfficeDefinition,
  type OfficeEffect,
  type OfficeEndReason,
  type OfficeOutcome,
  type OfficeRegistry,
  type OfficeState,
  type OfficeTerm,
} from "./offices.js";

export {
  CAPABILITY_VOCABULARY,
  GENESIS_CONSTITUTION,
  PROTECTED_RULE_IDS,
  executeProposal,
  genesisRules,
  policyExpression,
  validateDelegation,
  validateProposal,
  type Effect,
  type ExecutionResult,
  type ProposalValidation,
} from "./execute.js";
