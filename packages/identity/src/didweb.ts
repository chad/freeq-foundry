/**
 * `did:web` resolution.
 *
 * Required before any public run, because operators need identifiers they control and
 * can rotate ([ADR-0003](../../../docs/adr/0003-did-methods.md)). It brings three
 * obligations that ADR-0003 named, and all three are implemented here rather than
 * deferred:
 *
 *   1. **Resolution results are content-addressed and cached.** Replay must not depend
 *      on a third party still existing or still serving the same bytes (§6.9).
 *   2. **Rotation happens through credentials, not document mutation.** A changed
 *      document does not retroactively invalidate signatures made with a key that was
 *      valid at the time; revocation is an explicit signed event.
 *   3. **Fetches are untrusted network I/O.** Timeouts, size limits, no off-origin
 *      redirects, and no requests into private address space (§6.10).
 *
 * The third is the one worth dwelling on: a DID is participant-supplied, so
 * `did:web:127.0.0.1` or `did:web:169.254.169.254` is a server-side request forgery
 * attempt aimed at the controller's own network.
 *
 * Spec: §11.1, §6.9, §6.10. Decision: ADR-0003.
 */
import { hashCanonical, ProtocolError, ProtocolErrorCode } from "@freeq-foundry/protocol";
import type {
  DidDocument,
  DidResolution,
  DidResolver,
  ResolutionTime,
  VerificationMethod,
} from "./resolver.js";

export interface DidWebOptions {
  /** Injected so resolution is testable without network access. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /**
   * Cache of previously resolved documents, keyed by DID.
   *
   * Supplying a cache from a run's artifacts is what makes replay independent of the
   * network. Without it, resolution is a live dependency and a replay years later
   * would resolve differently or not at all.
   */
  readonly cache?: Map<string, CachedResolution>;
  /** Permit plain HTTP and private addresses. Test-only; never in a run. */
  readonly allowInsecure?: boolean;
}

export interface CachedResolution {
  readonly did: string;
  readonly document: DidDocument;
  /** Hash of the canonical document, so a later fetch can be compared to it. */
  readonly documentHash: string;
  readonly resolvedAt: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

/**
 * Hostnames and addresses a participant must not be able to make us fetch.
 *
 * Blocking by name is not sufficient on its own — DNS can resolve a public name to a
 * private address — but it closes the direct attempt, and the direct attempt is what
 * gets tried.
 */
const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "metadata.google.internal",
  "169.254.169.254",
]);

/**
 * Extract the host from an authority, handling bracketed IPv6.
 *
 * Splitting on `:` to strip a port yields `[` for `[::1]`, which then passes every
 * private-address check. An IPv6 loopback slipping through the SSRF guard is exactly
 * the bug this function exists to prevent, and it was present until a test caught it.
 */
function hostOf(authority: string): string {
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    return end === -1 ? authority : authority.slice(0, end + 1);
  }
  return authority.split(":")[0] as string;
}

function isPrivateAddress(host: string): boolean {
  if (BLOCKED_HOSTS.has(host.toLowerCase())) return true;
  // IPv4 private and link-local ranges.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  // Bracketed or colon-bearing hosts are IPv6: loopback, unspecified, unique-local,
  // and link-local are all refused.
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!normalized.includes(":")) return false;
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80")
  );
}

/** Convert a `did:web` identifier to its document URL, per the method spec. */
export function didWebToUrl(did: string, allowInsecure = false): string {
  if (!did.startsWith("did:web:")) {
    throw new ProtocolError(ProtocolErrorCode.INVALID_DID, `not a did:web: ${did}`);
  }
  const identifier = did.slice("did:web:".length);
  if (identifier === "") {
    throw new ProtocolError(ProtocolErrorCode.INVALID_DID, "did:web has no host");
  }

  // Colons separate path segments; the first segment is the host, optionally with a
  // percent-encoded port.
  const segments = identifier.split(":").map((segment) => decodeURIComponent(segment));
  const authority = segments[0] as string;
  const host = hostOf(authority);

  if (!allowInsecure && isPrivateAddress(host)) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_DID,
      `did:web host ${host} is a private or loopback address; a participant-supplied ` +
        `DID must not be able to direct a fetch into the platform's own network (§6.10)`,
    );
  }
  if (host === "" || host.includes("/") || host.includes("@") || host.includes("?")) {
    return (() => {
      throw new ProtocolError(
        ProtocolErrorCode.INVALID_DID,
        `did:web host ${JSON.stringify(host)} is malformed`,
      );
    })();
  }

  const scheme = allowInsecure ? "http" : "https";
  const path = segments.slice(1);
  return path.length === 0
    ? `${scheme}://${authority}/.well-known/did.json`
    : `${scheme}://${authority}/${path.join("/")}/did.json`;
}

export class DidWebResolver implements DidResolver {
  readonly method = "web";
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #cache: Map<string, CachedResolution>;
  readonly #allowInsecure: boolean;

  constructor(options: DidWebOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#cache = options.cache ?? new Map();
    this.#allowInsecure = options.allowInsecure ?? false;
  }

  canResolve(did: string): boolean {
    return did.startsWith("did:web:");
  }

  /** Cached resolutions, for the run's export bundle. */
  get cached(): readonly CachedResolution[] {
    return [...this.#cache.values()];
  }

  async resolve(did: string, at?: ResolutionTime): Promise<DidResolution> {
    const cached = this.#cache.get(did);
    if (cached !== undefined) {
      return {
        document: cached.document,
        // A cached document *is* historically accurate for the instant it was
        // captured: that is the point of caching it. Beyond that instant it is not,
        // and the caller is told so.
        historicallyAccurate: at === undefined || at.at === cached.resolvedAt,
        documentHash: cached.documentHash,
      };
    }

    const url = didWebToUrl(did, this.#allowInsecure);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(url, {
        signal: controller.signal,
        // No off-origin redirects: a redirect is a way to reach a blocked host after
        // passing the check.
        redirect: "error",
        headers: { accept: "application/did+json, application/json" },
      });

      if (!response.ok) {
        throw new ProtocolError(
          ProtocolErrorCode.INVALID_DID,
          `did:web resolution for ${did} returned ${response.status}`,
        );
      }

      const text = await response.text();
      if (text.length > this.#maxBytes) {
        throw new ProtocolError(
          ProtocolErrorCode.SIZE_EXCEEDED,
          `did:web document for ${did} is ${text.length} bytes, over the ${this.#maxBytes} limit`,
        );
      }

      const document = parseDidDocument(did, text);
      const entry: CachedResolution = {
        did,
        document,
        documentHash: hashCanonical(document as never),
        resolvedAt: new Date().toISOString(),
      };
      this.#cache.set(did, entry);

      return {
        document,
        historicallyAccurate: at === undefined,
        documentHash: entry.documentHash,
      };
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(
        ProtocolErrorCode.INVALID_DID,
        controller.signal.aborted
          ? `did:web resolution for ${did} timed out after ${this.#timeoutMs}ms`
          : `did:web resolution for ${did} failed: ${String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Seed the cache from a run's artifacts, making replay network-independent. */
  seed(entries: readonly CachedResolution[]): void {
    for (const entry of entries) this.#cache.set(entry.did, entry);
  }
}

/**
 * Parse a DID document.
 *
 * Only Ed25519 verification methods are accepted, matching
 * [ADR-0005](../../../docs/adr/0005-signature-suite.md). A document offering an
 * unusable key type would resolve successfully and then fail every signature check,
 * which is a confusing way to learn the suite is fixed.
 */
export function parseDidDocument(did: string, text: string): DidDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_DID,
      `did:web document for ${did} is not JSON`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_DID,
      `did:web document for ${did} is not an object`,
    );
  }

  const record = parsed as Record<string, unknown>;
  if (record["id"] !== did) {
    // A document claiming a different subject would let one operator serve another's
    // identity.
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_DID,
      `did:web document at the URL for ${did} claims id ${String(record["id"])}`,
    );
  }

  const rawMethods = record["verificationMethod"];
  if (!Array.isArray(rawMethods) || rawMethods.length === 0) {
    throw new ProtocolError(
      ProtocolErrorCode.INVALID_DID,
      `did:web document for ${did} exposes no verification method`,
    );
  }

  const methods: VerificationMethod[] = [];
  for (const raw of rawMethods) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const jwk = entry["publicKeyJwk"] as Record<string, unknown> | undefined;

    // Ed25519 only, expressed as an OKP JWK.
    if (jwk?.["kty"] !== "OKP" || jwk["crv"] !== "Ed25519") continue;
    const x = jwk["x"];
    if (typeof x !== "string") continue;

    const raw32 = Buffer.from(x, "base64url");
    if (raw32.length !== 32) continue;

    methods.push({
      id: String(entry["id"] ?? `${did}#0`),
      controller: String(entry["controller"] ?? did),
      publicKeyHex: raw32.toString("hex"),
      ...(typeof entry["validFrom"] === "string" ? { validFrom: entry["validFrom"] } : {}),
      ...(typeof entry["validUntil"] === "string"
        ? { validUntil: entry["validUntil"] }
        : {}),
    });
  }

  if (methods.length === 0) {
    throw new ProtocolError(
      ProtocolErrorCode.UNSUPPORTED_KEY_TYPE,
      `did:web document for ${did} offers no Ed25519 verification method; only ` +
        `Ed25519 is supported (ADR-0005)`,
    );
  }

  const services = record["service"];
  return {
    id: did,
    verificationMethods: methods,
    ...(Array.isArray(services)
      ? {
          serviceEndpoints: services
            .filter(
              (service): service is Record<string, unknown> =>
                typeof service === "object" && service !== null,
            )
            .map((service) => ({
              type: String(service["type"] ?? "unknown"),
              uri: String(service["serviceEndpoint"] ?? ""),
            })),
        }
      : {}),
  };
}

/** Build a document an operator can publish, for the onboarding guide. */
export function exampleDidDocument(did: string, publicKeyBase64Url: string): string {
  return JSON.stringify(
    {
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/jwk/v1"],
      id: did,
      verificationMethod: [
        {
          id: `${did}#key-1`,
          type: "JsonWebKey2020",
          controller: did,
          publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: publicKeyBase64Url },
        },
      ],
      authentication: [`${did}#key-1`],
    },
    null,
    2,
  );
}
