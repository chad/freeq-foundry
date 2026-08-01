/**
 * @freeq-foundry/model-adapters
 *
 * §25.1: one interface for every provider, so model diversity is a variable rather
 * than a slogan. §24.6: model output is a proposal, not a fact.
 */
export {
  classifyStatus,
  fetchTransport,
  invocationMicros,
  microsToUsdString,
  type HttpTransport,
  type ModelAdapter,
  type ModelFailureKind,
  type ModelMessage,
  type ModelPricing,
  type ModelRequest,
  type ModelResponse,
  type TokenUsage,
  type VerificationLevel,
} from "./types.js";

export {
  extractJson,
  parseStructuredResponse,
  repairPrompt,
  type ParseOutcome,
  type StructuredResponse,
} from "./structured.js";

export {
  AnthropicAdapter,
  OpenAiCompatibleAdapter,
  anthropicAdapter,
  kimiAdapter,
  llamaCppAdapter,
  ollamaAdapter,
  openAiAdapter,
  type ProviderAdapterOptions,
} from "./providers.js";

export {
  InvocationRecorder,
  ModelRouter,
  ReplayAdapter,
  ScriptedAdapter,
  hashRequest,
  type RecordedInvocation,
  type ReplayAdapterOptions,
  type RouteOutcome,
  type RouterOptions,
  type RouterTarget,
} from "./replay.js";

export { FREE, PRICING, pricingFor } from "./pricing.js";

export {
  ReactiveScriptedAdapter,
  dueProposalsFrom,
  listAfter,
  reviewablePullRequestsFrom,
  selfDidFrom,
  unclaimedWorkFrom,
  unvotedProposalsFrom,
  type ReactiveRule,
} from "./reactive.js";
