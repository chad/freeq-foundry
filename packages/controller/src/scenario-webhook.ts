/**
 * The `webhook-saas-v1` scenario: a real, small product.
 *
 * §59.19: "Keep the first product bounded. The purpose is institutional formation,
 * not unlimited startup ideation."
 *
 * The product is a webhook delivery service reduced to its pure core — signature
 * generation and verification, payload validation, and retry backoff. No HTTP
 * server, because a server would need ports and a network the sandbox forbids
 * (§6.10), and the interesting part is whether the *organization* can ship, not
 * whether Node can listen on a socket.
 *
 * ## An honest note on who writes the code
 *
 * Deterministic agents cannot invent an implementation, so this scenario supplies
 * one and the agents commit it. What is being tested is the **production pipeline** —
 * capability-gated commits, provenance on every commit, review requiring distinct
 * lineages, sandboxed CI, protected acceptance tests — not code generation. When
 * model adapters land (Milestone 7) the same pipeline receives generated code and
 * nothing here changes.
 *
 * Saying so plainly matters: a demo that looks like agents writing software, when
 * the software was in the scenario file, would be a misrepresentation.
 *
 * Spec: §9.3, §9.4, §59.19.
 */
import { buildCriterionModule, packageTests, type AcceptanceCriterion } from "@freeq-foundry/evaluation";

/** Files the organization starts with (§9.2). */
export function starterFiles(): ReadonlyMap<string, string> {
  return new Map([
    [
      "README.md",
      [
        "# Webhook Delivery Service",
        "",
        "A minimal webhook delivery core. Three modules are required:",
        "",
        "- `src/signature.mjs` — HMAC-SHA256 request signing and constant-time verification",
        "- `src/validate.mjs` — payload validation",
        "- `src/retry.mjs` — exponential backoff with jitter bounds",
        "",
        "Acceptance criteria are held by the external evaluator and are not in this",
        "repository. Descriptions are visible; the tests are not.",
      ].join("\n"),
    ],
    [
      "src/index.mjs",
      [
        "// Entry point. Re-exports the modules the evaluator exercises.",
        'export * from "./signature.mjs";',
        'export * from "./validate.mjs";',
        'export * from "./retry.mjs";',
      ].join("\n"),
    ],
  ]);
}

export interface ProductWorkItem {
  readonly workItemId: string;
  readonly mandatory: boolean;
  readonly description: string;
  readonly path: string;
  /**
   * The implementation an agent commits.
   *
   * Supplied by the scenario because deterministic agents cannot author code. See
   * the note at the top of this file.
   */
  readonly implementation: string;
}

export function workItems(): readonly ProductWorkItem[] {
  return [
    {
      workItemId: "signature",
      mandatory: true,
      description: "HMAC-SHA256 signing and constant-time verification of webhook payloads",
      path: "src/signature.mjs",
      implementation: [
        'import { createHmac, timingSafeEqual } from "node:crypto";',
        "",
        "export function sign(secret, payload, timestamp) {",
        '  if (typeof secret !== "string" || secret.length === 0) {',
        '    throw new TypeError("secret must be a non-empty string");',
        "  }",
        "  const body = `${timestamp}.${payload}`;",
        '  return "v1=" + createHmac("sha256", secret).update(body).digest("hex");',
        "}",
        "",
        "export function verify(secret, payload, timestamp, signature) {",
        "  const expected = sign(secret, payload, timestamp);",
        '  if (typeof signature !== "string" || signature.length !== expected.length) {',
        "    return false;",
        "  }",
        "  // Constant-time: a length-safe compare that does not leak via early exit.",
        "  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));",
        "}",
      ].join("\n"),
    },
    {
      workItemId: "validate",
      mandatory: true,
      description: "Payload validation: required fields, size ceiling, and event-name shape",
      path: "src/validate.mjs",
      implementation: [
        "const MAX_PAYLOAD_BYTES = 65536;",
        "const EVENT_PATTERN = /^[a-z][a-z0-9]*(?:\\.[a-z][a-z0-9]*)+$/;",
        "",
        "export function validate(payload) {",
        "  const errors = [];",
        '  if (payload === null || typeof payload !== "object") {',
        '    return { valid: false, errors: ["payload must be an object"] };',
        "  }",
        '  if (typeof payload.event !== "string") {',
        '    errors.push("event is required and must be a string");',
        "  } else if (!EVENT_PATTERN.test(payload.event)) {",
        '    errors.push("event must be dot.separated.lowercase");',
        "  }",
        '  if (typeof payload.id !== "string" || payload.id.length === 0) {',
        '    errors.push("id is required");',
        "  }",
        '  if (payload.data === undefined) {',
        '    errors.push("data is required");',
        "  }",
        "  const size = Buffer.byteLength(JSON.stringify(payload), \"utf8\");",
        "  if (size > MAX_PAYLOAD_BYTES) {",
        '    errors.push("payload exceeds " + MAX_PAYLOAD_BYTES + " bytes");',
        "  }",
        "  return { valid: errors.length === 0, errors };",
        "}",
      ].join("\n"),
    },
    {
      workItemId: "retry",
      mandatory: true,
      description: "Exponential backoff with a ceiling and bounded jitter",
      path: "src/retry.mjs",
      implementation: [
        "const BASE_MS = 1000;",
        "const CEILING_MS = 300000;",
        "export const MAX_ATTEMPTS = 6;",
        "",
        "export function backoffMs(attempt, jitterFraction = 0) {",
        "  if (!Number.isInteger(attempt) || attempt < 1) {",
        '    throw new RangeError("attempt must be a positive integer");',
        "  }",
        "  if (jitterFraction < 0 || jitterFraction > 1) {",
        '    throw new RangeError("jitterFraction must be between 0 and 1");',
        "  }",
        "  const exponential = Math.min(BASE_MS * 2 ** (attempt - 1), CEILING_MS);",
        "  // Jitter only ever reduces the delay, so the ceiling always holds.",
        "  return Math.round(exponential * (1 - jitterFraction * 0.5));",
        "}",
        "",
        "export function shouldRetry(attempt, statusCode) {",
        "  if (attempt >= MAX_ATTEMPTS) return false;",
        "  if (statusCode === 429) return true;",
        "  return statusCode >= 500 && statusCode < 600;",
        "}",
      ].join("\n"),
    },
    {
      workItemId: "docs",
      mandatory: false,
      description: "Usage documentation",
      path: "docs/usage.md",
      implementation: [
        "# Usage",
        "",
        "```js",
        'import { sign, verify, validate, backoffMs } from "./src/index.mjs";',
        "```",
      ].join("\n"),
    },
  ];
}

const criterion = (
  id: string,
  description: string,
  mandatory: boolean,
  body: string,
): AcceptanceCriterion => ({
  id,
  description,
  mandatory,
  testSource: buildCriterionModule(body),
});

/**
 * Acceptance criteria (§9.4).
 *
 * These never enter the repository and never appear in an agent's view. Each is a
 * plain Node module that exits non-zero on failure — no test framework, because the
 * sandbox cannot install dependencies without network access.
 *
 * They test behaviour the description does not fully specify, which is deliberate:
 * a criterion an agent could satisfy by reading its description alone would not be
 * testing much.
 */
export function acceptanceCriteria(): readonly AcceptanceCriterion[] {
  return [
    criterion(
      "signature-roundtrip",
      "Signing then verifying the same payload succeeds; a modified payload fails",
      true,
      [
        'const { sign, verify } = await import("./src/signature.mjs");',
        'const sig = sign("topsecret", \'{"a":1}\', 1700000000);',
        'assert(sig.startsWith("v1="), "signature must be prefixed v1=");',
        'assert(verify("topsecret", \'{"a":1}\', 1700000000, sig), "valid signature must verify");',
        'assert(!verify("topsecret", \'{"a":2}\', 1700000000, sig), "modified payload must not verify");',
        'assert(!verify("wrongkey", \'{"a":1}\', 1700000000, sig), "wrong secret must not verify");',
        'assert(!verify("topsecret", \'{"a":1}\', 1700000001, sig), "modified timestamp must not verify");',
      ].join("\n"),
    ),
    criterion(
      "signature-rejects-bad-input",
      "Signing rejects an empty secret, and verification tolerates malformed signatures",
      true,
      [
        'const { sign, verify } = await import("./src/signature.mjs");',
        "let threw = false;",
        'try { sign("", "x", 1); } catch { threw = true; }',
        'assert(threw, "an empty secret must throw");',
        "// A malformed signature must return false, never throw: a caller passing",
        "// attacker-controlled input should not get an exception.",
        'assert(verify("s", "x", 1, "") === false, "empty signature must return false");',
        'assert(verify("s", "x", 1, "garbage") === false, "garbage must return false");',
        'assert(verify("s", "x", 1, null) === false, "null must return false");',
      ].join("\n"),
    ),
    criterion(
      "validate-required-fields",
      "Validation reports every missing required field, not merely the first",
      true,
      [
        'const { validate } = await import("./src/validate.mjs");',
        'assert(validate({ event: "user.created", id: "1", data: {} }).valid, "valid payload must pass");',
        "const empty = validate({});",
        'assert(!empty.valid, "empty payload must fail");',
        'assert(empty.errors.length >= 3, "must report every missing field, got " + empty.errors.length);',
        'assert(!validate(null).valid, "null must fail");',
        'assert(!validate("string").valid, "a non-object must fail");',
      ].join("\n"),
    ),
    criterion(
      "validate-event-shape",
      "Event names must be dot-separated lowercase",
      true,
      [
        'const { validate } = await import("./src/validate.mjs");',
        'const ok = ["user.created", "billing.invoice.paid", "a.b"];',
        'const bad = ["User.Created", "nodot", "trailing.", ".leading", "has space.x", "UPPER.CASE"];',
        "for (const event of ok) {",
        '  assert(validate({ event, id: "1", data: {} }).valid, event + " should be accepted");',
        "}",
        "for (const event of bad) {",
        '  assert(!validate({ event, id: "1", data: {} }).valid, event + " should be rejected");',
        "}",
      ].join("\n"),
    ),
    criterion(
      "retry-backoff-bounds",
      "Backoff grows exponentially, never exceeds the ceiling, and rejects bad input",
      true,
      [
        'const { backoffMs, shouldRetry, MAX_ATTEMPTS } = await import("./src/retry.mjs");',
        "assertEqual(backoffMs(1), 1000, \"first attempt\");",
        "assertEqual(backoffMs(2), 2000, \"second attempt\");",
        "assertEqual(backoffMs(3), 4000, \"third attempt\");",
        "// The ceiling must hold however many attempts are requested.",
        "for (let attempt = 1; attempt <= 40; attempt++) {",
        '  assert(backoffMs(attempt) <= 300000, "attempt " + attempt + " must respect the ceiling");',
        "}",
        "// Jitter must only ever reduce the delay, or the ceiling is not a ceiling.",
        "for (const jitter of [0, 0.25, 0.5, 1]) {",
        '  assert(backoffMs(5, jitter) <= backoffMs(5, 0), "jitter must not increase the delay");',
        "}",
        "let threw = false;",
        "try { backoffMs(0); } catch { threw = true; }",
        'assert(threw, "attempt 0 must throw");',
        "threw = false;",
        "try { backoffMs(1, 2); } catch { threw = true; }",
        'assert(threw, "out-of-range jitter must throw");',
      ].join("\n"),
    ),
    criterion(
      "retry-policy",
      "Retries apply to 5xx and 429 only, and stop at the attempt ceiling",
      true,
      [
        'const { shouldRetry, MAX_ATTEMPTS } = await import("./src/retry.mjs");',
        'assert(shouldRetry(1, 500), "500 should retry");',
        'assert(shouldRetry(1, 503), "503 should retry");',
        'assert(shouldRetry(1, 429), "429 should retry");',
        'assert(!shouldRetry(1, 200), "200 should not retry");',
        'assert(!shouldRetry(1, 400), "400 should not retry");',
        'assert(!shouldRetry(1, 404), "404 should not retry");',
        'assert(!shouldRetry(MAX_ATTEMPTS, 500), "the attempt ceiling must stop retries");',
      ].join("\n"),
    ),
    criterion(
      "entry-point-exports",
      "The entry point re-exports the public surface",
      true,
      [
        'const api = await import("./src/index.mjs");',
        'for (const name of ["sign", "verify", "validate", "backoffMs", "shouldRetry"]) {',
        '  assert(typeof api[name] === "function", name + " must be exported from the entry point");',
        "}",
      ].join("\n"),
    ),
    criterion(
      "documentation-present",
      "Usage documentation exists",
      false,
      [
        'const { readFile } = await import("node:fs/promises");',
        "let content = \"\";",
        'try { content = await readFile("docs/usage.md", "utf8"); } catch { content = ""; }',
        'assert(content.length > 20, "usage documentation must exist and say something");',
      ].join("\n"),
    ),
  ];
}

export function webhookTestBundle() {
  return packageTests("webhook-saas-v1-acceptance", acceptanceCriteria());
}
