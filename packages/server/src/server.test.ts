import { deterministicKeyPair, attestEvent } from "@freeq-foundry/protocol";
import { InMemoryEventStore } from "@freeq-foundry/event-store";
import { Gateway, StaticAdmissionRegistry } from "@freeq-foundry/gateway";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FoundryServer } from "./server.js";
import { diagnose, discoveryDocument, discoveryMarkdown } from "./wellknown.js";

const recorder = deterministicKeyPair("recorder");
const alice = deterministicKeyPair("alice");
const RUN = "run-server";

let store: InMemoryEventStore;
let server: FoundryServer;
let base: string;

const draft = (sequence: number, visibility: unknown = { type: "public" }) => ({
  eventId: `e-${sequence}`,
  runId: RUN,
  eventType: "communication.message_posted",
  schemaVersion: 1,
  actorDid: alice.did,
  participantType: "agent" as const,
  participantSequence: sequence,
  wallTime: new Date(Date.UTC(2026, 0, 1, 0, sequence)).toISOString(),
  payload: { channelId: "genesis", text: `message ${sequence}` },
  visibility: visibility as never,
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
});

beforeEach(async () => {
  store = new InMemoryEventStore({
    recorderDid: recorder.did,
    recorderPrivateKey: recorder.privateKey,
  });
  await store.registerRun({ runId: RUN, recorderDid: recorder.did });

  const admissions = new StaticAdmissionRegistry();
  admissions.admit(RUN, {
    did: alice.did,
    participantType: "agent",
    admissionCredentialId: "adm-1",
  });

  server = new FoundryServer({
    gateway: new Gateway({ store, admissions, maxClockSkewMs: Number.MAX_SAFE_INTEGER }),
    store,
    runId: RUN,
    discovery: {
      runId: RUN,
      acceptingParticipants: true,
      recorderDid: recorder.did,
      evaluatorDid: deterministicKeyPair("evaluator").did,
      lineageConstraints: { maxDepth: 4, maxFanOutPerRoot: 8 },
    },
    vectors: { formatVersion: 1 },
  });
  base = await server.listen();
});

afterEach(async () => {
  await server.close();
});

describe("well-known discovery", () => {
  it("serves everything an operator needs from one URL", async () => {
    const response = await fetch(`${base}/.well-known/freeq-agent`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as Record<string, unknown>;

    // §59.15: one URL. If an operator has to read the specification to use this, the
    // endpoint has failed.
    expect(document["protocol"]).toBe("freeq-foundry/v1");
    expect((document["identity"] as Record<string, unknown>)["supportedDidMethods"]).toEqual(["key"]);
    expect(document["signingContexts"]).toHaveProperty("EVENT");
    expect(document["signingContexts"]).toHaveProperty("RECORD");
    expect((document["endpoints"] as Record<string, string>)["submit"]).toContain("/api/events");
    expect((document["authority"] as Record<string, unknown>)["model"]).toBe("no ambient authority");
  });

  it("publishes the recorder DID, so position attestation is checkable", async () => {
    // An event that named its own recorder would let a forger name themselves, so it
    // has to come from somewhere else — here.
    const document = (await (await fetch(`${base}/.well-known/freeq-agent`)).json()) as Record<
      string,
      unknown
    >;
    expect((document["run"] as Record<string, unknown>)["recorderDid"]).toBe(recorder.did);
  });

  it("negotiates a human-readable representation", async () => {
    const response = await fetch(`${base}/.well-known/freeq-agent?format=md`);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    const text = await response.text();
    expect(text).toContain("only URL you need");
    expect(text).toContain("Admission grants **nothing**");
  });

  it("serves conformance vectors so an implementer can self-certify", async () => {
    const response = await fetch(`${base}/.well-known/freeq-agent/vectors`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>)["formatVersion"]).toBe(1);
  });
});

describe("diagnostics", () => {
  it("reports every problem at once, not the first", async () => {
    // An operator iterating one error at a time against a remote endpoint is the
    // experience §13 exists to prevent.
    const response = await fetch(`${base}/.well-known/freeq-agent/diagnose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ did: "not-a-did", canonicalizationSample: { a: 1.5, b: null } }),
    });
    const result = (await response.json()) as {
      ready: boolean;
      findings: { code: string; remediation?: string }[];
    };
    expect(result.ready).toBe(false);
    expect(result.findings.length).toBeGreaterThan(2);
    for (const finding of result.findings) expect(finding.remediation).toBeDefined();
  });

  it("passes a well-formed configuration", () => {
    const result = diagnose({ did: alice.did, proof: {}, canonicalizationSample: { a: 1 } });
    expect(result.ready).toBe(true);
  });

  it("warns about a missing provenance proof without failing outright", () => {
    // Absent provenance is a warning at diagnose time and a refusal at admission: the
    // point of diagnosing is to find out before applying.
    const result = diagnose({ did: alice.did });
    expect(result.ready).toBe(true);
    expect(result.findings.some((f) => f.code === "PROVENANCE_ABSENT")).toBe(true);
  });

  it("catches canonicalization mistakes before they become signature failures", () => {
    const result = diagnose({ did: alice.did, canonicalizationSample: { cost: 0.42 } });
    expect(result.findings.some((f) => f.explanation.includes("not an integer"))).toBe(true);
  });
});

describe("event submission", () => {
  it("accepts a valid event with 202 and reports its position", async () => {
    const response = await fetch(`${base}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(attestEvent(draft(1), alice.privateKey)),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { accepted: boolean; logicalTime: number };
    expect(body.accepted).toBe(true);
    expect(body.logicalTime).toBe(0);
  });

  it("refuses an invalid event with 422 and a remediation", async () => {
    // 422, not 400: the request was understood and refused on its merits.
    const response = await fetch(`${base}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(attestEvent(draft(5), alice.privateKey)),
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { code: string; remediation?: string };
    expect(body.code).toBe("GAPPED_SEQUENCE");
    expect(body.remediation).toContain("lost");
  });

  it("tells a client where its sequence is, so it can resynchronize", async () => {
    await fetch(`${base}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(attestEvent(draft(1), alice.privateKey)),
    });
    const body = (await (
      await fetch(`${base}/api/sequence?did=${encodeURIComponent(alice.did)}`)
    ).json()) as { nextSequence: number };
    expect(body.nextSequence).toBe(2);
  });

  it("rejects a non-JSON body without crashing", async () => {
    const response = await fetch(`${base}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{{{",
    });
    expect(response.status).toBe(400);
  });
});

describe("observer", () => {
  it("serves a self-contained page with no build step", async () => {
    // It must still work when opened from a published dataset years later, and a
    // toolchain is the part most likely to have rotted.
    const html = await (await fetch(`${base}/observer`)).text();
    expect(html).toContain("FREEQ FOUNDRY");
    expect(html).toContain("EventSource");
    expect(html).not.toContain("<script src=");
  });

  it("lets anyone verify the chain", async () => {
    // A tamper-evident log nobody can check is tamper-evident in name only.
    await fetch(`${base}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(attestEvent(draft(1), alice.privateKey)),
    });
    const body = (await (await fetch(`${base}/api/verify`)).json()) as { valid: boolean };
    expect(body.valid).toBe(true);
  });

  it("withholds controller-only events from a spectator", async () => {
    // §33.7. A spectator must not be able to see private material by connecting to a
    // different endpoint.
    await fetch(`${base}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(attestEvent(draft(1, { type: "public" }), alice.privateKey)),
    });
    await fetch(`${base}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(attestEvent(draft(2, { type: "controller" }), alice.privateKey)),
    });

    const body = (await (await fetch(`${base}/api/events?did=did:key:zStranger`)).json()) as {
      events: { visibility: { type: string } }[];
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.visibility.type).toBe("public");
  });

  it("cannot be talked into a privileged role by a query parameter", async () => {
    // A query parameter is not authentication, and nothing here treats it as one.
    await fetch(`${base}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(attestEvent(draft(1, { type: "controller" }), alice.privateKey)),
    });
    const body = (await (
      await fetch(`${base}/api/events?did=did:key:zStranger&participantType=controller`)
    ).json()) as { events: unknown[] };
    expect(body.events).toHaveLength(0);
  });

  it("replays history to a late subscriber", async () => {
    for (const sequence of [1, 2, 3]) {
      await fetch(`${base}/api/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attestEvent(draft(sequence), alice.privateKey)),
      });
    }

    // A late observer must see the whole run, not only what happens after it connected.
    const response = await fetch(`${base}/api/stream`);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    while (!text.includes("caughtup")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();
    expect(text.match(/event: append/g) ?? []).toHaveLength(3);
  });

  it("answers 404 for an unknown route rather than hanging", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe("discovery document shape", () => {
  it("names did:web as unsupported rather than omitting it", () => {
    // Silence would read as "supported"; an operator needs to know why their did:web
    // identifier is refused.
    const document = discoveryDocument({
      baseUrl: "http://x",
      acceptingParticipants: true,
      recorderDid: "did:key:zR",
      evaluatorDid: "did:key:zE",
      lineageConstraints: { maxDepth: 4, maxFanOutPerRoot: 8 },
    });
    expect(JSON.stringify(document["identity"])).toContain("did:web is not yet supported");
  });

  it("renders markdown that explains the two-signature model", () => {
    const text = discoveryMarkdown({
      baseUrl: "http://x",
      acceptingParticipants: true,
      recorderDid: "did:key:zRecorder",
      evaluatorDid: "did:key:zE",
      lineageConstraints: { maxDepth: 4, maxFanOutPerRoot: 8 },
    });
    expect(text).toContain("Two signatures per event");
    expect(text).toContain("did:key:zRecorder");
  });
});

describe("response discipline", () => {
  it("answers every route exactly once", async () => {
    // A missing `return` in one branch wrote headers twice. The assertions still
    // passed; only the unhandled error revealed it. Now every route is exercised and
    // the responder itself refuses a second write.
    for (const path of [
      "/",
      "/observer",
      "/api/head",
      "/api/verify",
      "/api/events",
      "/.well-known/freeq-agent",
      "/.well-known/freeq-agent/vectors",
      "/nope",
    ]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBeLessThan(500);
      await response.text();
    }
  });
});
