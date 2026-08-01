/**
 * DID resolution.
 *
 * Resolution accepts an optional point in time. An implementation that cannot
 * answer a historical question must say so explicitly rather than silently
 * returning current state — a resolver that answers "which key was valid then?"
 * with present data is worse than one that refuses, because the caller cannot tell
 * (ADR-0003).
 *
 * Spec: §11.1. Decision: ADR-0003.
 */
import {
  ProtocolError,
  ProtocolErrorCode,
  publicKeyFromDidKey,
  rawPublicKeyFromDidKey,
} from "@freeq-foundry/protocol";
import type { KeyObject } from "node:crypto";

/** A point in time for historical resolution. */
export interface ResolutionTime {
  /** ISO 8601 instant. */
  readonly at: string;
}

export interface VerificationMethod {
  readonly id: string;
  readonly controller: string;
  readonly publicKeyHex: string;
  /** Absent means "valid from the beginning of time", which is true for did:key. */
  readonly validFrom?: string;
  readonly validUntil?: string;
}

export interface DidDocument {
  readonly id: string;
  readonly verificationMethods: readonly VerificationMethod[];
  readonly serviceEndpoints?: readonly { readonly type: string; readonly uri: string }[];
}

export interface DidResolution {
  readonly document: DidDocument;
  /**
   * Whether the resolver could honour a historical `at`.
   *
   * `false` means the document reflects current state and any conclusion about the
   * past drawn from it is unsound.
   */
  readonly historicallyAccurate: boolean;
  /** Content hash of the resolved document, for the replay artifact (ADR-0003). */
  readonly documentHash?: string;
}

export interface DidResolver {
  readonly method: string;
  canResolve(did: string): boolean;
  resolve(did: string, at?: ResolutionTime): Promise<DidResolution> | DidResolution;
}

/**
 * `did:key` resolution.
 *
 * A pure function: the key is in the identifier. No network, no storage, no
 * availability dependency, and no mutability problem — the key valid at issuance
 * is the key in the identifier, permanently. That is why ADR-0003 puts it first.
 *
 * It follows that `historicallyAccurate` is always true. Not because this resolver
 * consults history, but because `did:key` has none.
 */
export class DidKeyResolver implements DidResolver {
  readonly method = "key";

  canResolve(did: string): boolean {
    return did.startsWith("did:key:");
  }

  resolve(did: string): DidResolution {
    const raw = rawPublicKeyFromDidKey(did);
    return {
      document: {
        id: did,
        verificationMethods: [
          {
            id: `${did}#${did.slice("did:key:".length)}`,
            controller: did,
            publicKeyHex: Buffer.from(raw).toString("hex"),
          },
        ],
      },
      historicallyAccurate: true,
    };
  }
}

/**
 * Dispatches to a registered resolver by method.
 *
 * Deliberately not a universal resolver. Every supported method must have known
 * resolution and rotation semantics; accepting arbitrary methods would maximise
 * interoperability and minimise control, which is the wrong trade for a system
 * whose central claim is verifiable attribution (ADR-0003).
 */
export class DidResolverRegistry {
  readonly #resolvers: DidResolver[] = [];

  register(resolver: DidResolver): this {
    this.#resolvers.push(resolver);
    return this;
  }

  get methods(): readonly string[] {
    return this.#resolvers.map((r) => r.method);
  }

  async resolve(did: string, at?: ResolutionTime): Promise<DidResolution> {
    const resolver = this.#resolvers.find((r) => r.canResolve(did));
    if (resolver === undefined) {
      const method = did.startsWith("did:") ? did.split(":")[1] : undefined;
      throw new ProtocolError(
        method === undefined
          ? ProtocolErrorCode.INVALID_DID
          : ProtocolErrorCode.UNSUPPORTED_DID_METHOD,
        method === undefined
          ? `not a DID: ${JSON.stringify(did)}`
          : `no resolver registered for did:${method}; supported: ${this.methods.join(", ")}`,
      );
    }
    return resolver.resolve(did, at);
  }

  /** Public key for a DID, or throws. */
  async publicKey(did: string, at?: ResolutionTime): Promise<KeyObject> {
    const resolution = await this.resolve(did, at);
    const method = resolution.document.verificationMethods[0];
    if (method === undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.INVALID_DID,
        `DID document for ${did} exposes no verification method`,
      );
    }
    if (did.startsWith("did:key:")) {
      // The key is in the identifier, so this round-trips without trusting the
      // document we just built from it.
      return publicKeyFromDidKey(did);
    }
    // For a resolved document, build the key from the published material. Uses the
    // first Ed25519 method; a document with several would need selection by key id,
    // which no supported method requires yet.
    const { publicKeyFromRaw } = await import("@freeq-foundry/protocol");
    return publicKeyFromRaw(Uint8Array.from(Buffer.from(method.publicKeyHex, "hex")));
  }
}

/**
 * A registry with `did:key` only.
 *
 * The offline default: no network in the verification path, which is what makes
 * conformance tests runnable without infrastructure (ADR-0003).
 */
export function defaultResolvers(): DidResolverRegistry {
  return new DidResolverRegistry().register(new DidKeyResolver());
}

/**
 * A registry including `did:web`, for admitting external operators.
 *
 * Separate from the default so nothing acquires a network dependency by accident. A
 * run that admits strangers needs this; a run that does not should not have it.
 */
export async function resolversWithWeb(
  options: import("./didweb.js").DidWebOptions = {},
): Promise<DidResolverRegistry> {
  const { DidWebResolver } = await import("./didweb.js");
  return new DidResolverRegistry()
    .register(new DidKeyResolver())
    .register(new DidWebResolver(options));
}

/**
 * Was a verification method valid at an instant?
 *
 * Separated out because it is the check most easily skipped: condition 4 of
 * §11.4 asks whether keys were valid *at issuance*, not whether they are valid
 * now. A credential signed by a key that had already been retired must fail even
 * though the signature verifies.
 */
export function methodValidAt(method: VerificationMethod, at: string): boolean {
  const instant = Date.parse(at);
  if (Number.isNaN(instant)) return false;
  if (method.validFrom !== undefined && instant < Date.parse(method.validFrom)) {
    return false;
  }
  if (method.validUntil !== undefined && instant > Date.parse(method.validUntil)) {
    return false;
  }
  return true;
}
