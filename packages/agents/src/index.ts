/**
 * @freeq-foundry/agents
 *
 * The action space, the provider-neutral adapter contract, and deterministic
 * agents — which are what make a run provable without model spend.
 */
export {
  ModelAgent,
  PERSONAS,
  modelAgent,
  type ModelAgentOptions,
} from "./model-agent.js";

export {
  DeterministicAgent,
  builderAgent,
  institutionalistAgent,
  invocationCost,
  weakSaboteurAgent,
  type ActionRequest,
  type AgentAdapter,
  type AgentView,
  type DeterministicRule,
  type InvocationRecord,
} from "./runtime.js";
