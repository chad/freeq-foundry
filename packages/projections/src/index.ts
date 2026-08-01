/**
 * @freeq-foundry/projections
 *
 * The event log is authoritative; queryable state is derived (§34.1).
 */
export {
  forEventTypes,
  project,
  projectAll,
  projectAsync,
  resume,
  type Projector,
  type Snapshot,
} from "./projector.js";

export * from "./events.js";

export {
  activeGrantsFor,
  activeRules,
  activityProjector,
  authorityConcentration,
  autonomyDisagreements,
  capabilitiesProjector,
  constitutionProjector,
  coreProjectors,
  distinctLineages,
  elapsedRunClockMs,
  governanceCostShare,
  governanceOverhead,
  leadershipTurnover,
  officesHeld,
  officesProjector,
  outcomeProjector,
  participantsProjector,
  proposalsProjector,
  remainingCredits,
  runProjector,
  treasuryProjector,
  type ActivityState,
  type CapabilitiesState,
  type ConstitutionState,
  type GrantState,
  type OfficeRecord,
  type OfficeTermState,
  type OfficesState,
  type OutcomeState,
  type ParticipantState,
  type ParticipantsState,
  type ProposalState,
  type ProposalsState,
  type RunState,
  type TreasuryState,
} from "./core.js";
