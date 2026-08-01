/**
 * Validates the published conformance vectors against the published schemas.
 *
 * This is the drift guard between the TypeScript types and the JSON Schemas.
 * Hand-written schemas can diverge from the types they describe; the vectors are
 * generated from the types, so if the two disagree, this fails.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// ajv ships CJS interop that TypeScript's ESM resolution sees as a namespace,
// so the constructor and the type are pulled out explicitly.
import ajvModule, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const Ajv2020 = ajvModule as unknown as new (options: {
  strict: boolean;
  allErrors: boolean;
}) => {
  addSchema(schema: unknown): void;
  getSchema(id: string): ValidateFunction | undefined;
};
const addFormats = addFormatsModule as unknown as (ajv: unknown) => void;
import { beforeAll, describe, expect, it } from "vitest";
import { attestEvent } from "./event.js";
import { deterministicKeyPair } from "./testing.js";
import {
  COMPATIBILITY_POLICY,
  SCHEMA_BASE_URI,
  SCHEMA_VERSION,
  schemaById,
  schemas,
} from "./schema.js";
import type { VectorSet } from "./vectors.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(join(here, "..", "vectors", "index.json"), "utf8"),
) as VectorSet;

let ajv: InstanceType<typeof Ajv2020>;

beforeAll(() => {
  ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const schema of schemas) ajv.addSchema(schema);
});

const validator = (id: string) => {
  const validate = ajv.getSchema(id);
  if (validate === undefined) throw new Error(`no schema compiled for ${id}`);
  return validate;
};

describe("schemas compile", () => {
  it("every schema is valid JSON Schema 2020-12 under strict mode", () => {
    // Ajv strict mode rejects unknown keywords and ambiguous constructs, so
    // compiling at all is a meaningful assertion.
    for (const schema of schemas) {
      expect(schema["$id"], "every schema needs an $id").toBeDefined();
      expect(ajv.getSchema(schema["$id"] as string)).toBeDefined();
    }
  });

  it("every $id is unique", () => {
    const ids = schemas.map((s) => s["$id"] as string);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("schemaById resolves published schemas", () => {
    expect(schemaById(`${SCHEMA_BASE_URI}/recorded-event.json`)).toBeDefined();
    expect(schemaById("nonexistent")).toBeUndefined();
  });
});

describe("recorded events validate", () => {
  it("every event in the published run", () => {
    const validate = validator(`${SCHEMA_BASE_URI}/recorded-event.json`);
    for (const event of vectors.events.events) {
      const ok = validate(event);
      expect(validate.errors ?? [], `event ${event.eventId}`).toEqual([]);
      expect(ok).toBe(true);
    }
  });

  it("every visibility variant in the published run", () => {
    // The sample run deliberately includes a controller-only event.
    const kinds = new Set(vectors.events.events.map((e) => e.visibility.type));
    expect(kinds.has("public")).toBe(true);
    expect(kinds.has("controller")).toBe(true);
  });

  it("rejects an event missing the recorder attestation", () => {
    const validate = validator(`${SCHEMA_BASE_URI}/recorded-event.json`);
    const { recorderSignature: _omitted, ...withoutRecorder } = vectors.events
      .events[0] as unknown as Record<string, unknown>;
    expect(validate(withoutRecorder)).toBe(false);
  });

  it("rejects an unknown envelope field", () => {
    // Not fastidiousness: an unknown field is covered by eventHash and both
    // signatures, so tolerating it means attesting to uninterpretable content.
    const validate = validator(`${SCHEMA_BASE_URI}/recorded-event.json`);
    expect(
      validate({ ...vectors.events.events[0], surprise: "extra" }),
    ).toBe(false);
  });

  it("rejects a malformed digest", () => {
    const validate = validator(`${SCHEMA_BASE_URI}/recorded-event.json`);
    expect(validate({ ...vectors.events.events[0], eventHash: "sha256:zzz" })).toBe(
      false,
    );
  });

  it("rejects a non-integer logical time", () => {
    const validate = validator(`${SCHEMA_BASE_URI}/recorded-event.json`);
    expect(validate({ ...vectors.events.events[0], logicalTime: 1.5 })).toBe(false);
  });

  it("rejects a zero participant sequence", () => {
    const validate = validator(`${SCHEMA_BASE_URI}/recorded-event.json`);
    expect(validate({ ...vectors.events.events[0], participantSequence: 0 })).toBe(
      false,
    );
  });

  it("rejects a padded base64 signature", () => {
    const validate = validator(`${SCHEMA_BASE_URI}/recorded-event.json`);
    expect(validate({ ...vectors.events.events[0], signature: "AAAA=" })).toBe(false);
  });
});

describe("attributed events validate", () => {
  const alice = deterministicKeyPair("alice");

  const draft = {
    eventId: "evt-schema-1",
    runId: "run-schema",
    eventType: "channel.message",
    schemaVersion: 1,
    actorDid: alice.did,
    participantType: "agent" as const,
    participantSequence: 1,
    wallTime: "2026-01-01T00:00:00.000Z",
    payload: { text: "hello" },
    visibility: { type: "public" as const },
    references: [],
    provenance: {
      signerDid: alice.did,
      terminalHumanDids: [alice.did],
      provenancePathHashes: [],
      admissionCredentialId: "adm-1",
      directInstructionEventIds: [],
      governanceAuthorizationIds: [],
      capabilityGrantIds: [],
    },
  };

  it("accepts a participant-attested submission", () => {
    const validate = validator(`${SCHEMA_BASE_URI}/attributed-event.json`);
    const attested = attestEvent(draft, alice.privateKey);
    expect(validate(attested)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it("rejects a submission that supplies its own position", () => {
    // A client that could set logicalTime could place itself in history.
    const validate = validator(`${SCHEMA_BASE_URI}/attributed-event.json`);
    const attested = attestEvent(draft, alice.privateKey);
    expect(validate({ ...attested, logicalTime: 0 })).toBe(false);
  });

  it("rejects a submission carrying a recorder signature", () => {
    const validate = validator(`${SCHEMA_BASE_URI}/attributed-event.json`);
    const attested = attestEvent(draft, alice.privateKey);
    expect(validate({ ...attested, recorderSignature: "A".repeat(86) })).toBe(false);
  });
});

describe("visibility policy", () => {
  const validate = () => validator(`${SCHEMA_BASE_URI}/visibility-policy.json`);

  it("accepts all five levels", () => {
    for (const policy of [
      { type: "public" },
      { type: "channel", channelId: "genesis" },
      { type: "participants", participantDids: ["did:key:zA"] },
      { type: "lineage", terminalHumanDid: "did:key:zB" },
      { type: "controller" },
      { type: "post_run_reveal", revealPolicyId: "rp-1" },
    ]) {
      expect(validate()(policy), JSON.stringify(policy)).toBe(true);
    }
  });

  it("rejects a channel policy without a channel", () => {
    expect(validate()({ type: "channel" })).toBe(false);
  });

  it("rejects an unknown policy type", () => {
    expect(validate()({ type: "everyone_eventually" })).toBe(false);
  });

  it("rejects extra fields, which could smuggle a wider audience", () => {
    expect(
      validate()({ type: "controller", participantDids: ["did:key:zA"] }),
    ).toBe(false);
  });
});

describe("model invocation record", () => {
  const validate = () =>
    validator(`${SCHEMA_BASE_URI}/model-invocation-record.json`);

  const record = {
    id: "mi-1",
    runId: "run-1",
    participantDid: "did:key:zAlice",
    activationId: "act-1",
    adapterId: "anthropic-v1",
    provider: "anthropic",
    modelIdentifier: "claude-sonnet-4-5",
    inputArtifactHash: `sha256:${"a".repeat(64)}`,
    budgetAccount: "acct-1",
    status: "succeeded",
  };

  it("accepts a minimal record", () => {
    expect(validate()(record)).toBe(true);
  });

  it("accepts a pinned snapshot", () => {
    expect(
      validate()({
        ...record,
        snapshot: {
          provider: "anthropic",
          modelIdentifier: "claude-sonnet-4-5",
          snapshotIdentifier: "claude-sonnet-4-5-20250929",
          apiVersion: "2023-06-01",
          systemPromptHash: `sha256:${"a".repeat(64)}`,
          toolSchemaHash: `sha256:${"b".repeat(64)}`,
          temperature: "0.7",
          returnedModelIdentifier: "claude-sonnet-4-5-20250929",
          invokedAt: "2026-01-01T00:00:00.000Z",
          verificationLevel: 4,
        },
      }),
    ).toBe(true);
  });

  it("rejects a float cost, because money is not a binary float", () => {
    expect(validate()({ ...record, costUsd: 0.42 })).toBe(false);
    expect(validate()({ ...record, costUsd: "0.42" })).toBe(true);
  });

  it("rejects a verification level outside the ladder", () => {
    const withLevel = (verificationLevel: number) => ({
      ...record,
      snapshot: {
        provider: "p",
        modelIdentifier: "m",
        snapshotIdentifier: "s",
        apiVersion: "v",
        systemPromptHash: `sha256:${"a".repeat(64)}`,
        toolSchemaHash: `sha256:${"b".repeat(64)}`,
        invokedAt: "2026-01-01T00:00:00.000Z",
        verificationLevel,
      },
    });
    expect(validate()(withLevel(4))).toBe(true);
    expect(validate()(withLevel(5))).toBe(false);
    expect(validate()(withLevel(-1))).toBe(false);
  });
});

describe("compatibility policy", () => {
  it("is stated rather than implied, as §33.6 requires", () => {
    expect(COMPATIBILITY_POLICY.schemaVersion).toBe(SCHEMA_VERSION);
    expect(COMPATIBILITY_POLICY.breaking.length).toBeGreaterThan(0);
    expect(COMPATIBILITY_POLICY.backwardsCompatible.length).toBeGreaterThan(0);
    expect(COMPATIBILITY_POLICY.migration).toContain("never rewritten");
  });

  it("classifies canonical-form changes as breaking", () => {
    expect(COMPATIBILITY_POLICY.breaking.join(" ")).toContain(
      "canonical serialization",
    );
  });
});
