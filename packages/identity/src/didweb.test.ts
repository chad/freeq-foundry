import { generateKeyPair, rawPublicKey } from "@freeq-foundry/protocol";
import { describe, expect, it } from "vitest";
import {
  DidWebResolver,
  didWebToUrl,
  exampleDidDocument,
  parseDidDocument,
  type CachedResolution,
} from "./didweb.js";

const operator = generateKeyPair();
const publicKeyBase64Url = Buffer.from(rawPublicKey(operator.publicKey)).toString("base64url");
const DID = "did:web:agents.example.com";

const documentFor = (did: string): string => exampleDidDocument(did, publicKeyBase64Url);

const fetchReturning = (status: number, body: string): typeof fetch =>
  (async () =>
    ({
      ok: status === 200,
      status,
      text: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;

describe("did:web URL derivation", () => {
  it("maps a bare host to /.well-known/did.json", () => {
    expect(didWebToUrl("did:web:example.com")).toBe(
      "https://example.com/.well-known/did.json",
    );
  });

  it("maps path segments from colons", () => {
    expect(didWebToUrl("did:web:example.com:agents:alice")).toBe(
      "https://example.com/agents/alice/did.json",
    );
  });

  it("refuses a non-did:web", () => {
    expect(() => didWebToUrl("did:key:z6Mk")).toThrow(/not a did:web/);
  });
});

describe("did:web SSRF protection", () => {
  it("refuses loopback and private addresses", () => {
    // A DID is participant-supplied, so did:web:127.0.0.1 is a request-forgery attempt
    // aimed at the controller's own network (§6.10).
    for (const host of [
      "localhost",
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.1",
      "172.16.0.1",
      "169.254.169.254",
      "metadata.google.internal",
      "0.0.0.0",
    ]) {
      expect(() => didWebToUrl(`did:web:${host}`), host).toThrow(/private or loopback/);
    }
  });

  it("refuses IPv6 loopback, unspecified, unique-local, and link-local", () => {
    // Splitting an authority on ":" to strip a port yields "[" for "[::1]", which then
    // passes every private-address check. This test found that hole.
    for (const host of ["[::1]", "[::]", "[fd00::1]", "[fc00::1]", "[fe80::1]"]) {
      expect(() => didWebToUrl(`did:web:${encodeURIComponent(host)}`), host).toThrow(
        /private or loopback/,
      );
    }
  });

  it("still permits a public IPv6 host", () => {
    expect(didWebToUrl(`did:web:${encodeURIComponent("[2606:4700::1]")}`)).toContain("https://");
  });

  it("permits a public host", () => {
    expect(didWebToUrl("did:web:agents.example.com")).toContain("https://");
  });

  it("uses https, never http", () => {
    expect(didWebToUrl("did:web:example.com").startsWith("https://")).toBe(true);
  });

  it("refuses off-origin redirects at fetch time", async () => {
    // A redirect is a way to reach a blocked host after passing the check.
    let sawRedirectOption = "";
    const resolver = new DidWebResolver({
      fetchImpl: (async (_url: string, init: { redirect?: string }) => {
        sawRedirectOption = init.redirect ?? "";
        return { ok: true, status: 200, text: async () => documentFor(DID) } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    await resolver.resolve(DID);
    expect(sawRedirectOption).toBe("error");
  });
});

describe("did:web resolution", () => {
  it("resolves a valid document", async () => {
    const resolver = new DidWebResolver({ fetchImpl: fetchReturning(200, documentFor(DID)) });
    const resolution = await resolver.resolve(DID);
    expect(resolution.document.id).toBe(DID);
    expect(resolution.document.verificationMethods[0]?.publicKeyHex).toBe(
      Buffer.from(rawPublicKey(operator.publicKey)).toString("hex"),
    );
    expect(resolution.documentHash).toMatch(/^sha256:/);
  });

  it("content-addresses the document, so replay does not depend on the server", async () => {
    // §6.9. Without this, a replay years later would resolve differently or not at all.
    const resolver = new DidWebResolver({ fetchImpl: fetchReturning(200, documentFor(DID)) });
    const first = await resolver.resolve(DID);
    expect(resolver.cached).toHaveLength(1);
    expect(resolver.cached[0]?.documentHash).toBe(first.documentHash);
  });

  it("serves a cached document without refetching", async () => {
    let calls = 0;
    const resolver = new DidWebResolver({
      fetchImpl: (async () => {
        calls++;
        return { ok: true, status: 200, text: async () => documentFor(DID) } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    await resolver.resolve(DID);
    await resolver.resolve(DID);
    expect(calls).toBe(1);
  });

  it("can be seeded from artifacts, making replay network-independent", async () => {
    const seeded: CachedResolution = {
      did: DID,
      document: {
        id: DID,
        verificationMethods: [
          { id: `${DID}#k`, controller: DID, publicKeyHex: "ab".repeat(32) },
        ],
      },
      documentHash: `sha256:${"c".repeat(64)}`,
      resolvedAt: "2026-01-01T00:00:00.000Z",
    };
    const resolver = new DidWebResolver({
      fetchImpl: (() => {
        throw new Error("must not fetch when seeded");
      }) as unknown as typeof fetch,
    });
    resolver.seed([seeded]);
    const resolution = await resolver.resolve(DID);
    expect(resolution.documentHash).toBe(seeded.documentHash);
  });

  it("is honest about historical accuracy", async () => {
    // A resolver that answered a historical question with present data would be worse
    // than one that refuses, because the caller could not tell.
    const resolver = new DidWebResolver({ fetchImpl: fetchReturning(200, documentFor(DID)) });
    const live = await resolver.resolve(DID, { at: "2020-01-01T00:00:00.000Z" });
    expect(live.historicallyAccurate).toBe(false);
  });

  it("reports a fetch failure as an invalid DID rather than throwing raw", async () => {
    const resolver = new DidWebResolver({ fetchImpl: fetchReturning(404, "not found") });
    await expect(resolver.resolve(DID)).rejects.toThrow(/returned 404/);
  });

  it("bounds document size", async () => {
    const resolver = new DidWebResolver({
      fetchImpl: fetchReturning(200, "x".repeat(200_000)),
      maxBytes: 1000,
    });
    await expect(resolver.resolve(DID)).rejects.toThrow(/over the 1000/);
  });
});

describe("did:web document parsing", () => {
  it("refuses a document claiming a different subject", () => {
    // Otherwise one operator could serve another's identity.
    expect(() => parseDidDocument(DID, documentFor("did:web:someone.else"))).toThrow(
      /claims id/,
    );
  });

  it("refuses a document with no Ed25519 method", () => {
    // Resolving successfully and then failing every signature check is a confusing way
    // to learn the suite is fixed (ADR-0005).
    const p256 = JSON.stringify({
      id: DID,
      verificationMethod: [
        { id: `${DID}#k`, publicKeyJwk: { kty: "EC", crv: "P-256", x: "a", y: "b" } },
      ],
    });
    expect(() => parseDidDocument(DID, p256)).toThrow(/no Ed25519 verification method/);
  });

  it("refuses a wrong-length key", () => {
    const short = JSON.stringify({
      id: DID,
      verificationMethod: [
        { id: `${DID}#k`, publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "AAAA" } },
      ],
    });
    expect(() => parseDidDocument(DID, short)).toThrow(/no Ed25519/);
  });

  it("refuses non-JSON and empty method lists", () => {
    expect(() => parseDidDocument(DID, "not json")).toThrow(/not JSON/);
    expect(() => parseDidDocument(DID, JSON.stringify({ id: DID }))).toThrow(
      /no verification method/,
    );
  });

  it("carries validity windows through, so condition 4 can be checked", () => {
    const withWindow = JSON.stringify({
      id: DID,
      verificationMethod: [
        {
          id: `${DID}#k`,
          controller: DID,
          publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: publicKeyBase64Url },
          validFrom: "2026-01-01T00:00:00.000Z",
          validUntil: "2026-06-01T00:00:00.000Z",
        },
      ],
    });
    const document = parseDidDocument(DID, withWindow);
    expect(document.verificationMethods[0]?.validFrom).toBe("2026-01-01T00:00:00.000Z");
  });

  it("produces a publishable example an operator can copy", () => {
    const example = JSON.parse(exampleDidDocument(DID, publicKeyBase64Url)) as Record<
      string,
      unknown
    >;
    expect(example["id"]).toBe(DID);
    // And it round-trips through our own parser, so the guidance is not aspirational.
    expect(parseDidDocument(DID, exampleDidDocument(DID, publicKeyBase64Url)).id).toBe(DID);
  });
});
