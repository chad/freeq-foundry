/**
 * The provider-neutral model interface.
 *
 * §25.1: one interface for every provider. This is what lets model diversity be a
 * *variable* rather than a slogan (§59.18) — a run can hold role, incentive, and
 * memory constant while varying only the model, which is impossible if each
 * provider has its own call shape leaking into agent code.
 *
 * §24.6 governs the posture throughout: **model output is a proposal, not a fact.**
 * Nothing here assumes a response is well formed, truthful, or authorized.
 *
 * Spec: §24.5, §24.6, §25, §47.1, §47.2. Decision: ADR-0009.
 */

/** A message in a conversation. No provider-specific fields. */
export interface ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/**
 * Everything pinned about a call, per ADR-0009.
 *
 * Recorded before the call so intent is provable even if the call fails.
 */
export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  /** Provider-agnostic ceiling on response length. */
  readonly maxOutputTokens: number;
  /** Decimal string, because ADR-0004 forbids floats in canonical payloads. */
  readonly temperature?: string;
  /** Reasoning or thinking parameters, provider-specific but recorded uniformly. */
  readonly reasoningParameters?: Readonly<Record<string, string>>;
  /** Idempotency hint, so a retried call is not billed twice where supported. */
  readonly requestId?: string;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type ModelFailureKind =
  | "rate_limited"
  | "overloaded"
  | "timeout"
  | "auth"
  | "invalid_request"
  | "content_filtered"
  | "network"
  | "unknown";

/**
 * The outcome of a call.
 *
 * A discriminated union rather than a throw. Provider failure is an expected
 * condition the scheduler must handle (§47.2), not an exception — and a union forces
 * the caller to decide what to do about it.
 */
export type ModelResponse =
  | {
      readonly ok: true;
      readonly text: string;
      readonly usage: TokenUsage;
      /**
       * The model identifier the provider actually returned.
       *
       * Recorded because a mismatch with the requested snapshot is silent endpoint
       * substitution, which is the drift the research protocol defends against
       * (ADR-0009). Absent when a provider does not report it.
       */
      readonly returnedModelIdentifier?: string;
      readonly latencyMs: number;
    }
  | {
      readonly ok: false;
      readonly kind: ModelFailureKind;
      readonly message: string;
      /** Whether retrying the same request could plausibly succeed. */
      readonly retryable: boolean;
      readonly latencyMs: number;
    };

/**
 * Evidence for which model produced a response (research protocol §8).
 *
 * `4` platform-mediated is the only level this package can produce for its own
 * adapters. An externally operated agent's claim about its model is level `1` at
 * best, and condition assignment may never depend on level 0–1.
 */
export type VerificationLevel = 0 | 1 | 2 | 3 | 4;

export interface ModelAdapter {
  readonly id: string;
  readonly provider: string;
  /** Family identifier, e.g. `gpt-4o`. */
  readonly modelIdentifier: string;
  /** Pinned snapshot, e.g. `gpt-4o-2024-08-06`. §7 of the research protocol. */
  readonly snapshotIdentifier: string;
  readonly apiVersion: string;
  readonly verificationLevel: VerificationLevel;
  invoke(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * Injectable transport.
 *
 * Exists so provider adapters are testable without network access or credentials.
 * An adapter that can only be exercised against a live paid endpoint is an adapter
 * that does not get tested.
 */
export interface HttpTransport {
  (
    url: string,
    init: {
      readonly method: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<{
    readonly status: number;
    readonly text: () => Promise<string>;
  }>;
}

/** Default transport over global fetch. Node 20+ needs no dependency for this. */
export const fetchTransport: HttpTransport = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body,
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  });
  return { status: response.status, text: () => response.text() };
};

/**
 * Classify an HTTP status into a failure kind.
 *
 * Shared across providers so failover behaves identically regardless of which one
 * failed — otherwise a 429 from one provider and a 429 from another would be handled
 * differently for no reason.
 */
export function classifyStatus(status: number): {
  readonly kind: ModelFailureKind;
  readonly retryable: boolean;
} {
  if (status === 401 || status === 403) return { kind: "auth", retryable: false };
  if (status === 400 || status === 422) {
    return { kind: "invalid_request", retryable: false };
  }
  if (status === 429) return { kind: "rate_limited", retryable: true };
  if (status === 408 || status === 504) return { kind: "timeout", retryable: true };
  if (status === 529 || status === 503) return { kind: "overloaded", retryable: true };
  if (status >= 500) return { kind: "unknown", retryable: true };
  return { kind: "unknown", retryable: false };
}

/** Per-million-token prices, as integer micro-USD to avoid float drift. */
export interface ModelPricing {
  readonly inputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
}

/**
 * Cost of a call, in integer micro-USD.
 *
 * Integer arithmetic throughout: money accumulated in binary floating point drifts,
 * and a treasury that drifts is a treasury nobody trusts. Rounds up, so the platform
 * never under-reports spend against a hard ceiling.
 */
export function invocationMicros(usage: TokenUsage, pricing: ModelPricing): number {
  const input = Math.ceil((usage.inputTokens * pricing.inputMicrosPerMillion) / 1_000_000);
  const output = Math.ceil(
    (usage.outputTokens * pricing.outputMicrosPerMillion) / 1_000_000,
  );
  return input + output;
}

/** Format micro-USD as a decimal string for a canonical payload. */
export function microsToUsdString(micros: number): string {
  const sign = micros < 0 ? "-" : "";
  const absolute = Math.abs(micros);
  const whole = Math.floor(absolute / 1_000_000);
  const fraction = String(absolute % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return fraction === "" ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}
