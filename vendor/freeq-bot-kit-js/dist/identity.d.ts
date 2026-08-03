import { type DidKey } from "@freeq/sdk";
export interface AgentIdentity {
    /** `did:key:z…` — agent's cryptographic principal. */
    did: string;
    /** SDK key object for SASL signing. */
    didKey: DidKey;
    /** True when this run generated the key (first launch). */
    isFresh: boolean;
}
export interface LoadOrCreateIdentityOptions {
    /** Absolute path to the seed file. The parent directory is created if needed. */
    seedPath: string;
}
export declare function loadOrCreateIdentity(opts: LoadOrCreateIdentityOptions): Promise<AgentIdentity>;
//# sourceMappingURL=identity.d.ts.map