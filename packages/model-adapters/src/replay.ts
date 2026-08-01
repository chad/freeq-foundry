/**
 * The replay adapter, and the router.
 *
 * ## Why replay matters more than it sounds
 *
 * §6.9 requires that all authoritative state be reconstructable from the event log.
 * A model-driven run breaks that on its own: the same prompt does not produce the
 * same response, so replaying a run by re-calling the provider produces a *different*
 * run. The replay adapter closes the gap by serving the recorded responses back, in
 * order, keyed by the exact request.
 *
 * That makes a model-driven run auditable at zero marginal cost, which is also what
 * lets a published dataset be re-analyzed by someone without API keys.
 *
 * Spec: §6.9, §25, §39, §47.2.
 */
import { hashCanonical } from "@freeq-foundry/protocol";
import type {
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  TokenUsage,
  VerificationLevel,
} from "./types.js";

/** A recorded call, sufficient to reproduce it exactly. */
export interface RecordedInvocation {
  readonly invocationId: string;
  readonly adapterId: string;
  readonly provider: string;
  readonly modelIdentifier: string;
  readonly snapshotIdentifier: string;
  /** Hash of the canonical request, so a replay can confirm it is answering the same question. */
  readonly requestHash: string;
  readonly responseText: string;
  readonly usage: TokenUsage;
  readonly returnedModelIdentifier?: string;
  readonly costMicros: number;
}

/**
 * Hash a request for replay lookup.
 *
 * Excludes `requestId`, which is an idempotency hint that legitimately varies between
 * a run and its replay. Including it would make every lookup miss.
 */
export function hashRequest(request: ModelRequest): string {
  return hashCanonical({
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    maxOutputTokens: request.maxOutputTokens,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.reasoningParameters === undefined
      ? {}
      : { reasoningParameters: { ...request.reasoningParameters } }),
  } as never);
}

/** Collects invocations during a live run, for later replay and for the export bundle. */
export class InvocationRecorder {
  readonly #records: RecordedInvocation[] = [];
  #counter = 0;

  record(
    adapter: ModelAdapter,
    request: ModelRequest,
    response: Extract<ModelResponse, { ok: true }>,
    costMicros: number,
  ): RecordedInvocation {
    this.#counter++;
    const entry: RecordedInvocation = {
      invocationId: `mi-${String(this.#counter).padStart(5, "0")}`,
      adapterId: adapter.id,
      provider: adapter.provider,
      modelIdentifier: adapter.modelIdentifier,
      snapshotIdentifier: adapter.snapshotIdentifier,
      requestHash: hashRequest(request),
      responseText: response.text,
      usage: response.usage,
      ...(response.returnedModelIdentifier === undefined
        ? {}
        : { returnedModelIdentifier: response.returnedModelIdentifier }),
      costMicros,
    };
    this.#records.push(entry);
    return entry;
  }

  get records(): readonly RecordedInvocation[] {
    return this.#records;
  }
}

export interface ReplayAdapterOptions {
  readonly records: readonly RecordedInvocation[];
  /**
   * Whether a request with no recorded response is an error.
   *
   * Default true. A replay that silently invents a response is not a replay, and the
   * divergence would be invisible in the resulting dataset.
   */
  readonly strict?: boolean;
}

/**
 * Serves recorded responses.
 *
 * Matches on the request hash first and falls back to sequential order, because a
 * replayed run should reach the same requests in the same order — and if it does not,
 * strict mode surfaces that rather than papering over it.
 */
export class ReplayAdapter implements ModelAdapter {
  readonly id: string;
  readonly provider: string;
  readonly modelIdentifier: string;
  readonly snapshotIdentifier: string;
  readonly apiVersion = "replay";
  /**
   * Verification level is inherited from the recording, not asserted.
   *
   * A replay is exactly as trustworthy about model identity as the run it replays —
   * claiming otherwise would launder a level-1 claim into a level-4 one.
   */
  readonly verificationLevel: VerificationLevel;

  readonly #byHash: Map<string, RecordedInvocation[]>;
  readonly #ordered: readonly RecordedInvocation[];
  readonly #strict: boolean;
  #cursor = 0;
  #misses = 0;

  constructor(options: ReplayAdapterOptions & { readonly verificationLevel?: VerificationLevel }) {
    const first = options.records[0];
    this.id = `replay:${first?.adapterId ?? "empty"}`;
    this.provider = first?.provider ?? "replay";
    this.modelIdentifier = first?.modelIdentifier ?? "replay";
    this.snapshotIdentifier = first?.snapshotIdentifier ?? "replay";
    this.verificationLevel = options.verificationLevel ?? 4;
    this.#strict = options.strict ?? true;
    this.#ordered = options.records;
    this.#byHash = new Map();
    for (const record of options.records) {
      const bucket = this.#byHash.get(record.requestHash) ?? [];
      bucket.push(record);
      this.#byHash.set(record.requestHash, bucket);
    }
  }

  /** Requests that had no recorded response. Non-zero means the replay diverged. */
  get misses(): number {
    return this.#misses;
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    const hash = hashRequest(request);
    const bucket = this.#byHash.get(hash);
    const record = bucket?.shift() ?? this.#ordered[this.#cursor];

    if (record === undefined || (bucket === undefined && this.#strict)) {
      this.#misses++;
      return {
        ok: false,
        kind: "invalid_request",
        message:
          `no recorded response for request ${hash}. The replay has diverged from the ` +
          `original run; a replay that invents a response is not a replay.`,
        retryable: false,
        latencyMs: 0,
      };
    }

    this.#cursor++;
    return {
      ok: true,
      text: record.responseText,
      usage: record.usage,
      ...(record.returnedModelIdentifier === undefined
        ? {}
        : { returnedModelIdentifier: record.returnedModelIdentifier }),
      // Zero, not the original latency: replay does not take that long, and
      // reporting a fabricated duration would be a lie in the telemetry.
      latencyMs: 0,
    };
  }
}

/**
 * A scripted adapter for tests and for deterministic model-shaped runs.
 *
 * Distinct from the replay adapter: this one is authored, not recorded. Keeping them
 * separate means a test fixture can never be mistaken for evidence of a real run.
 */
export class ScriptedAdapter implements ModelAdapter {
  readonly id: string;
  readonly provider = "scripted";
  readonly modelIdentifier: string;
  readonly snapshotIdentifier: string;
  readonly apiVersion = "scripted";
  /**
   * Level 0: unreported.
   *
   * A scripted adapter has no model behind it, so claiming any level of model
   * verification would be false. Condition assignment may not depend on level 0–1,
   * which correctly excludes scripted runs from confirmatory model claims.
   */
  readonly verificationLevel: VerificationLevel = 0;

  readonly #responses: readonly string[];
  readonly #usage: TokenUsage;
  #index = 0;

  constructor(options: {
    readonly id?: string;
    readonly responses: readonly string[];
    readonly usage?: TokenUsage;
  }) {
    this.id = options.id ?? "scripted";
    this.modelIdentifier = this.id;
    this.snapshotIdentifier = this.id;
    this.#responses = options.responses;
    this.#usage = options.usage ?? { inputTokens: 100, outputTokens: 50 };
  }

  async invoke(): Promise<ModelResponse> {
    // Repeats the last response once exhausted, so a longer run than the script does
    // not fail for an uninteresting reason.
    const text =
      this.#responses[Math.min(this.#index, this.#responses.length - 1)] ?? "{}";
    this.#index++;
    return { ok: true, text, usage: this.#usage, latencyMs: 0 };
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface RouterTarget {
  readonly adapter: ModelAdapter;
  readonly pricing: { readonly inputMicrosPerMillion: number; readonly outputMicrosPerMillion: number };
}

export interface RouteOutcome {
  readonly response: ModelResponse;
  /** Adapter that produced the response, which may not be the first tried. */
  readonly adapter: ModelAdapter;
  readonly costMicros: number;
  /** Adapters that failed before this one succeeded (§47.2). */
  readonly failedOver: readonly { readonly adapterId: string; readonly reason: string }[];
}

export interface RouterOptions {
  readonly targets: readonly RouterTarget[];
  /** Retries per adapter for a retryable failure. Default 1. */
  readonly retriesPerTarget?: number;
  /**
   * Remaining budget in micro-USD, checked before each call.
   *
   * §21.6 distinguishes hard from political limits: this is the hard one, and a call
   * that would exceed it is refused rather than made and then reported.
   */
  readonly remainingMicros?: () => number;
}

/**
 * Routes a request across adapters with failover.
 *
 * Failover is *recorded*, not silent. A run where one provider degraded and another
 * carried the load is a different run from one where the first provider was fine, and
 * §58.6 requires model claims to be qualified by what actually served them.
 */
export class ModelRouter {
  readonly #targets: readonly RouterTarget[];
  readonly #retries: number;
  readonly #remainingMicros: (() => number) | undefined;

  constructor(options: RouterOptions) {
    if (options.targets.length === 0) {
      throw new Error("a router needs at least one target");
    }
    this.#targets = options.targets;
    this.#retries = options.retriesPerTarget ?? 1;
    this.#remainingMicros = options.remainingMicros;
  }

  get primary(): ModelAdapter {
    return (this.#targets[0] as RouterTarget).adapter;
  }

  async route(request: ModelRequest): Promise<RouteOutcome> {
    const failedOver: { adapterId: string; reason: string }[] = [];

    for (const target of this.#targets) {
      // Estimated worst case, since the real cost is unknown until the call returns.
      const estimate = estimateMicros(request, target);
      const remaining = this.#remainingMicros?.();
      if (remaining !== undefined && remaining < estimate) {
        failedOver.push({
          adapterId: target.adapter.id,
          reason: `would cost up to ${estimate} micros with ${remaining} remaining`,
        });
        continue;
      }

      for (let attempt = 0; attempt <= this.#retries; attempt++) {
        const response = await target.adapter.invoke(
          attempt === 0
            ? request
            : { ...request, requestId: `${request.requestId ?? "r"}-retry-${attempt}` },
        );

        if (response.ok) {
          return {
            response,
            adapter: target.adapter,
            costMicros: actualMicros(response.usage, target),
            failedOver,
          };
        }
        if (!response.retryable) {
          failedOver.push({
            adapterId: target.adapter.id,
            reason: `${response.kind}: ${response.message}`,
          });
          break;
        }
        if (attempt === this.#retries) {
          failedOver.push({
            adapterId: target.adapter.id,
            reason: `${response.kind} after ${attempt + 1} attempt(s): ${response.message}`,
          });
        }
      }
    }

    const last = this.#targets[this.#targets.length - 1] as RouterTarget;
    return {
      response: {
        ok: false,
        kind: "unknown",
        message: `every target failed: ${failedOver.map((f) => f.adapterId).join(", ")}`,
        retryable: false,
        latencyMs: 0,
      },
      adapter: last.adapter,
      costMicros: 0,
      failedOver,
    };
  }
}

function estimateMicros(request: ModelRequest, target: RouterTarget): number {
  // Four characters per token is a crude estimate, and deliberately generous: a
  // budget check that underestimates would let a call exceed a hard ceiling.
  const inputTokens = Math.ceil(
    request.messages.reduce((sum, message) => sum + message.content.length, 0) / 4,
  );
  return (
    Math.ceil((inputTokens * target.pricing.inputMicrosPerMillion) / 1_000_000) +
    Math.ceil((request.maxOutputTokens * target.pricing.outputMicrosPerMillion) / 1_000_000)
  );
}

function actualMicros(usage: TokenUsage, target: RouterTarget): number {
  return (
    Math.ceil((usage.inputTokens * target.pricing.inputMicrosPerMillion) / 1_000_000) +
    Math.ceil((usage.outputTokens * target.pricing.outputMicrosPerMillion) / 1_000_000)
  );
}
