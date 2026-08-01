/**
 * Model prices, in integer micro-USD per million tokens.
 *
 * Integers because ADR-0004 forbids floats in canonical payloads and because money
 * accumulated in binary floating point drifts. A price of $3.00 per million input
 * tokens is 3_000_000 micros.
 *
 * These are defaults for cost accounting, not a claim about current list prices. A
 * run pins its own table in the scenario, so a price change cannot retroactively
 * alter what a past run reports having spent.
 */
import type { ModelPricing } from "./types.js";

export const PRICING: Readonly<Record<string, ModelPricing>> = {
  // Frontier-tier defaults.
  "anthropic:premium": { inputMicrosPerMillion: 3_000_000, outputMicrosPerMillion: 15_000_000 },
  "anthropic:standard": { inputMicrosPerMillion: 800_000, outputMicrosPerMillion: 4_000_000 },
  "openai:premium": { inputMicrosPerMillion: 2_500_000, outputMicrosPerMillion: 10_000_000 },
  "openai:standard": { inputMicrosPerMillion: 150_000, outputMicrosPerMillion: 600_000 },
  "kimi:standard": { inputMicrosPerMillion: 600_000, outputMicrosPerMillion: 2_500_000 },

  /**
   * Local runtimes cost no money but are not free.
   *
   * Zero USD, but the treasury still charges credits (§21.1): scarcity must bind in
   * every arm, or a local-model condition faces looser constraints than a
   * provider-backed one and the two are not comparable.
   */
  "ollama:local": { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
  "llama.cpp:local": { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
  "scripted:none": { inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
};

export const FREE: ModelPricing = {
  inputMicrosPerMillion: 0,
  outputMicrosPerMillion: 0,
};

/**
 * Look up pricing, defaulting to the most expensive tier for the provider.
 *
 * Defaulting *up* rather than to zero: an unpriced model that reports no cost would
 * silently spend against a hard ceiling without registering, and under-reporting
 * spend is the failure mode that matters.
 */
export function pricingFor(provider: string, tier = "standard"): ModelPricing {
  const exact = PRICING[`${provider}:${tier}`];
  if (exact !== undefined) return exact;
  const premium = PRICING[`${provider}:premium`];
  if (premium !== undefined) return premium;
  if (provider === "ollama" || provider === "llama.cpp" || provider === "scripted") {
    return FREE;
  }
  return PRICING["anthropic:premium"] as ModelPricing;
}
