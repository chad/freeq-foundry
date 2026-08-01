/**
 * Provider adapters.
 *
 * §25.2 requires OpenAI, Anthropic, Kimi, Ollama, and llama.cpp. All five reduce to
 * two wire shapes — OpenAI-compatible chat completions, and Anthropic messages — so
 * that is how they are implemented, rather than five near-duplicate files that drift.
 *
 * Every adapter takes an injectable transport, because an adapter that can only be
 * exercised against a live paid endpoint does not get tested.
 *
 * Spec: §25.
 */
import {
  classifyStatus,
  fetchTransport,
  type HttpTransport,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
  type VerificationLevel,
} from "./types.js";

export interface ProviderAdapterOptions {
  readonly apiKey: string;
  readonly snapshotIdentifier: string;
  readonly modelIdentifier?: string;
  readonly baseUrl?: string;
  readonly transport?: HttpTransport;
  readonly timeoutMs?: number;
  /** Injectable clock, so latency is testable without sleeping. */
  readonly now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Shared timing, timeout, and error handling. */
async function withTiming(
  now: () => number,
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<ModelResponse>,
): Promise<ModelResponse> {
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await call(controller.signal);
  } catch (error) {
    // A network error or an abort. Retryable: the request may not have been
    // received, and §47.2 wants provider failure survivable.
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      kind: aborted ? "timeout" : "network",
      message: aborted ? `aborted after ${timeoutMs}ms` : String(error),
      retryable: true,
      latencyMs: now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * OpenAI-compatible chat completions.
 *
 * Covers OpenAI, Kimi (Moonshot), Ollama's compatibility endpoint, and llama.cpp's
 * server — they differ by base URL and pricing, not by protocol.
 */
export class OpenAiCompatibleAdapter implements ModelAdapter {
  readonly id: string;
  readonly provider: string;
  readonly modelIdentifier: string;
  readonly snapshotIdentifier: string;
  readonly apiVersion = "v1/chat/completions";
  readonly verificationLevel: VerificationLevel = 4;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #transport: HttpTransport;
  readonly #timeoutMs: number;
  readonly #now: () => number;

  constructor(
    provider: string,
    baseUrl: string,
    options: ProviderAdapterOptions,
  ) {
    this.provider = provider;
    this.id = `${provider}:${options.snapshotIdentifier}`;
    this.snapshotIdentifier = options.snapshotIdentifier;
    this.modelIdentifier = options.modelIdentifier ?? options.snapshotIdentifier;
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl ?? baseUrl;
    this.#transport = options.transport ?? fetchTransport;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  invoke(request: ModelRequest): Promise<ModelResponse> {
    return withTiming(this.#now, this.#timeoutMs, async (signal) => {
      const started = this.#now();
      const body: Record<string, unknown> = {
        model: this.snapshotIdentifier,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        max_tokens: request.maxOutputTokens,
      };
      if (request.temperature !== undefined) {
        body["temperature"] = Number(request.temperature);
      }
      for (const [key, value] of Object.entries(request.reasoningParameters ?? {})) {
        body[key] = value;
      }

      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      // A local runtime needs no key; sending an empty Authorization header would
      // make some servers reject the request outright.
      if (this.#apiKey !== "") headers["authorization"] = `Bearer ${this.#apiKey}`;

      const response = await this.#transport(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });

      const text = await response.text();
      if (response.status !== 200) {
        const { kind, retryable } = classifyStatus(response.status);
        return {
          ok: false,
          kind,
          message: `${this.provider} returned ${response.status}: ${truncate(text)}`,
          retryable,
          latencyMs: this.#now() - started,
        };
      }

      const parsed = safeJson(text);
      const content =
        parsed?.["choices"] !== undefined && Array.isArray(parsed["choices"])
          ? (parsed["choices"][0] as Record<string, unknown> | undefined)?.["message"]
          : undefined;
      const output = (content as Record<string, unknown> | undefined)?.["content"];

      if (typeof output !== "string") {
        return {
          ok: false,
          kind: "invalid_request",
          message: `${this.provider} response had no message content: ${truncate(text)}`,
          retryable: false,
          latencyMs: this.#now() - started,
        };
      }

      const usage = (parsed?.["usage"] ?? {}) as Record<string, unknown>;
      const returned = parsed?.["model"];
      return {
        ok: true,
        text: output,
        usage: {
          inputTokens: asCount(usage["prompt_tokens"]),
          outputTokens: asCount(usage["completion_tokens"]),
        },
        ...(typeof returned === "string" ? { returnedModelIdentifier: returned } : {}),
        latencyMs: this.#now() - started,
      };
    });
  }
}

export function openAiAdapter(options: ProviderAdapterOptions): ModelAdapter {
  return new OpenAiCompatibleAdapter("openai", "https://api.openai.com/v1", options);
}

export function kimiAdapter(options: ProviderAdapterOptions): ModelAdapter {
  return new OpenAiCompatibleAdapter("kimi", "https://api.moonshot.cn/v1", options);
}

/**
 * Ollama, for a locally hosted model.
 *
 * Verification level 4 despite being local: the platform mediates the invocation and
 * knows which weights were asked for. What it cannot verify is that the local server
 * honoured the request, which is the same limitation as any provider.
 */
export function ollamaAdapter(
  options: Omit<ProviderAdapterOptions, "apiKey"> & { readonly apiKey?: string },
): ModelAdapter {
  return new OpenAiCompatibleAdapter("ollama", "http://127.0.0.1:11434/v1", {
    ...options,
    apiKey: options.apiKey ?? "",
  });
}

export function llamaCppAdapter(
  options: Omit<ProviderAdapterOptions, "apiKey"> & { readonly apiKey?: string },
): ModelAdapter {
  return new OpenAiCompatibleAdapter("llama.cpp", "http://127.0.0.1:8080/v1", {
    ...options,
    apiKey: options.apiKey ?? "",
  });
}

/** Anthropic messages API. A different wire shape, not merely a different URL. */
export class AnthropicAdapter implements ModelAdapter {
  readonly id: string;
  readonly provider = "anthropic";
  readonly modelIdentifier: string;
  readonly snapshotIdentifier: string;
  readonly apiVersion = "2023-06-01";
  readonly verificationLevel: VerificationLevel = 4;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #transport: HttpTransport;
  readonly #timeoutMs: number;
  readonly #now: () => number;

  constructor(options: ProviderAdapterOptions) {
    this.id = `anthropic:${options.snapshotIdentifier}`;
    this.snapshotIdentifier = options.snapshotIdentifier;
    this.modelIdentifier = options.modelIdentifier ?? options.snapshotIdentifier;
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl ?? "https://api.anthropic.com/v1";
    this.#transport = options.transport ?? fetchTransport;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  invoke(request: ModelRequest): Promise<ModelResponse> {
    return withTiming(this.#now, this.#timeoutMs, async (signal) => {
      const started = this.#now();

      // Anthropic takes the system prompt as a top-level field rather than a
      // message, so it must be lifted out rather than passed through.
      const system = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const conversation = request.messages.filter((message) => message.role !== "system");

      const body: Record<string, unknown> = {
        model: this.snapshotIdentifier,
        max_tokens: request.maxOutputTokens,
        messages: conversation.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      };
      if (system !== "") body["system"] = system;
      if (request.temperature !== undefined) {
        body["temperature"] = Number(request.temperature);
      }
      for (const [key, value] of Object.entries(request.reasoningParameters ?? {})) {
        body[key] = value;
      }

      const response = await this.#transport(`${this.#baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": this.apiVersion,
        },
        body: JSON.stringify(body),
        signal,
      });

      const text = await response.text();
      if (response.status !== 200) {
        const { kind, retryable } = classifyStatus(response.status);
        return {
          ok: false,
          kind,
          message: `anthropic returned ${response.status}: ${truncate(text)}`,
          retryable,
          latencyMs: this.#now() - started,
        };
      }

      const parsed = safeJson(text);
      const blocks = parsed?.["content"];
      // Concatenate text blocks and ignore the rest: a thinking block is not the
      // response, and §33.8 says the platform should not require hidden reasoning.
      const output = Array.isArray(blocks)
        ? blocks
            .filter(
              (block): block is Record<string, unknown> =>
                typeof block === "object" &&
                block !== null &&
                (block as Record<string, unknown>)["type"] === "text",
            )
            .map((block) => String(block["text"] ?? ""))
            .join("")
        : undefined;

      if (output === undefined || output === "") {
        return {
          ok: false,
          kind: parsed?.["stop_reason"] === "refusal" ? "content_filtered" : "invalid_request",
          message: `anthropic response had no text content: ${truncate(text)}`,
          retryable: false,
          latencyMs: this.#now() - started,
        };
      }

      const usage = (parsed?.["usage"] ?? {}) as Record<string, unknown>;
      const returned = parsed?.["model"];
      return {
        ok: true,
        text: output,
        usage: {
          inputTokens: asCount(usage["input_tokens"]),
          outputTokens: asCount(usage["output_tokens"]),
        },
        ...(typeof returned === "string" ? { returnedModelIdentifier: returned } : {}),
        latencyMs: this.#now() - started,
      };
    });
  }
}

export function anthropicAdapter(options: ProviderAdapterOptions): ModelAdapter {
  return new AnthropicAdapter(options);
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function truncate(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
