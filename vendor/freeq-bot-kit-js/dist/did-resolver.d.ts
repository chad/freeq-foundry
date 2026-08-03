import type { FreeqEvents } from "@freeq/sdk";
/** Minimal subset of the FreeqClient surface this primitive needs. The
 *  full client satisfies this interface. */
export interface DidResolverClient {
    raw(line: string): void;
    on<K extends "memberDid" | "userRenamed" | "userQuit">(event: K, handler: FreeqEvents[K]): void;
    off<K extends "memberDid" | "userRenamed" | "userQuit">(event: K, handler: FreeqEvents[K]): void;
}
export interface DidResolverOptions {
    /** WHOIS race timeout in ms. Default 3000. Per-call override available
     *  via `ResolveOpts.timeoutMs`. */
    timeoutMs?: number;
    /** Cache entries expire this many ms after insert. Default 300_000 (5
     *  min). The cache can miss invalidation events for users not in shared
     *  channels; TTL bounds the staleness window regardless. */
    cacheTtlMs?: number;
}
export interface ResolveOpts {
    /** Override the resolver's default WHOIS timeout for this call. */
    timeoutMs?: number;
    /** Consult/store the nick→DID cache. Default true. Set false for fresh
     *  lookups every time (no stale-cache risk; pays a WHOIS round-trip). */
    cache?: boolean;
    /** Fall back to WHOIS on cache miss. Default true. Set false to
     *  short-circuit: account-tag → cache → null, no round-trip. */
    whois?: boolean;
}
export interface DidResolver {
    /** Resolve the sender's DID. Returns null if the message has no
     *  account-tag, the cache doesn't know, and WHOIS times out (or is
     *  disabled). */
    resolve(msg: {
        from: string;
        tags?: Record<string, string>;
    }, opts?: ResolveOpts): Promise<string | null>;
    /** Detach all SDK event listeners and clear the cache. */
    close(): void;
}
export declare function createDidResolver(client: DidResolverClient, opts?: DidResolverOptions): DidResolver;
//# sourceMappingURL=did-resolver.d.ts.map