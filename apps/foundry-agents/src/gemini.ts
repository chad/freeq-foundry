/**
 * Gemini adapter.
 *
 * A third wire shape: neither OpenAI-compatible nor Anthropic. Lives here rather than in
 * `model-adapters` because §25.2 names five providers and Google is not among them —
 * adding it to the core package would quietly widen a documented contract, whereas the
 * roster genuinely wants a fourth family so heterogeneity is more than two vendors.
 */
import { classifyStatus, fetchTransport, type HttpTransport, type ModelAdapter, type ModelRequest, type ModelResponse, type VerificationLevel } from "@freeq-foundry/model-adapters";

export interface GeminiOptions {
  readonly apiKey: string;
  readonly snapshotIdentifier: string;
  readonly baseUrl?: string;
  readonly transport?: HttpTransport;
  readonly timeoutMs?: number;
}

export function geminiAdapter(options: GeminiOptions): ModelAdapter {
  const baseUrl = options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  const transport = options.transport ?? fetchTransport;
  const timeoutMs = options.timeoutMs ?? 120_000;

  return {
    id: `google:${options.snapshotIdentifier}`,
    provider: "google",
    modelIdentifier: options.snapshotIdentifier,
    snapshotIdentifier: options.snapshotIdentifier,
    apiVersion: "v1beta",
    verificationLevel: 4 as VerificationLevel,

    async invoke(request: ModelRequest): Promise<ModelResponse> {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        // Gemini takes the system prompt as `systemInstruction`, and calls the assistant
        // role "model". Passing either through unchanged is silently accepted and then
        // ignored, which is the worst failure mode: it looks like it worked.
        const system = request.messages
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n\n");
        const contents = request.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          }));

        const body: Record<string, unknown> = {
          contents,
          generationConfig: {
            maxOutputTokens: request.maxOutputTokens,
            ...(request.temperature === undefined
              ? {}
              : { temperature: Number(request.temperature) }),
          },
        };
        if (system !== "") body["systemInstruction"] = { parts: [{ text: system }] };

        const response = await transport(
          `${baseUrl}/models/${options.snapshotIdentifier}:generateContent`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              // Header, not a query parameter: a key in a URL lands in access logs.
              "x-goog-api-key": options.apiKey,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );

        const text = await response.text();
        if (response.status !== 200) {
          const { kind, retryable } = classifyStatus(response.status);
          return {
            ok: false,
            kind,
            message: `google returned ${response.status}: ${text.slice(0, 300)}`,
            retryable,
            latencyMs: Date.now() - started,
          };
        }

        const parsed = JSON.parse(text) as Record<string, unknown>;
        const candidates = parsed["candidates"];
        const first = Array.isArray(candidates) ? (candidates[0] as Record<string, unknown>) : undefined;
        const parts = (first?.["content"] as Record<string, unknown> | undefined)?.["parts"];
        const output = Array.isArray(parts)
          ? parts.map((part) => String((part as Record<string, unknown>)["text"] ?? "")).join("")
          : undefined;

        if (output === undefined || output === "") {
          return {
            ok: false,
            // A safety block is a refusal, not a malformed response, and retrying the
            // format would not help.
            kind: first?.["finishReason"] === "SAFETY" ? "content_filtered" : "invalid_request",
            message: `google response had no text: ${text.slice(0, 300)}`,
            retryable: false,
            latencyMs: Date.now() - started,
          };
        }

        const usage = (parsed["usageMetadata"] ?? {}) as Record<string, unknown>;
        const returned = parsed["modelVersion"];
        return {
          ok: true,
          text: output,
          usage: {
            inputTokens: Number(usage["promptTokenCount"] ?? 0),
            outputTokens: Number(usage["candidatesTokenCount"] ?? 0),
          },
          ...(typeof returned === "string" ? { returnedModelIdentifier: returned } : {}),
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        return {
          ok: false,
          kind: controller.signal.aborted ? "timeout" : "network",
          message: String(error),
          retryable: true,
          latencyMs: Date.now() - started,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
