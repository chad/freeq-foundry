# Webhook Delivery Service

Three modules are required under `src/`:

- `signature.mjs` — HMAC-SHA256 `sign(secret, payload, timestamp)` and a
  constant-time `verify(secret, payload, timestamp, signature)`
- `validate.mjs` — `validate(payload)` returning `{ valid, errors }`
- `retry.mjs` — `backoffMs(attempt)` with a ceiling, and `shouldRetry(attempt, status)`

Plain ES modules. No dependencies and no network — the sandbox has neither.
Acceptance criteria are held externally and are not in this repository.