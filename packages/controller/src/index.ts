/**
 * @freeq-foundry/controller
 *
 * Executes a run from genesis to termination. Everything it does is an event, so
 * nothing is held in memory that cannot be rebuilt from the log (§6.9).
 */
export { EventWriter, type EventWriterOptions } from "./writer.js";
export {
  executeRun,
  webhookScenario,
  type ParticipantSpec,
  type RunConfig,
  type RunResult,
  type Scenario,
  type WorkItem,
} from "./run.js";

export {
  acceptanceCriteria,
  starterFiles,
  webhookTestBundle,
  workItems,
  type ProductWorkItem,
} from "./scenario-webhook.js";
