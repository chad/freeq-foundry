export interface DelegationCert {
    /** Always "FreeqBotDelegation/v1". Server's verifier dispatches on this. */
    type: "FreeqBotDelegation/v1";
    /** Bot's DID — must match the SASL-authenticated session DID, server checks. */
    bot_did: string;
    /** Multibase ed25519 pubkey of the bot (the part after "did:key:"). */
    bot_public_key: string;
    /** Owner's DID, typically did:plc:… */
    creator_did: string;
    /** ISO-8601 timestamp the cert was minted. */
    created_at: string;
    /** Who can revoke this binding. Same as creator_did in v1.0. */
    revocation_authority: string;
    /**
     * Base64url ed25519 signature over the JCS-canonical form of the cert with
     * this field omitted. Signed by the creator's key when one is provided
     * (see `signDelegation` / `creatorKeyPath`); null otherwise, in which
     * case the server treats the cert as declarative metadata.
     */
    signature: string | null;
}
/**
 * RFC 8785 (JCS) canonicalization, restricted to the value shapes a
 * delegation cert can contain: objects, arrays, strings, booleans, null,
 * and safe integers. Must produce byte-identical output to
 * `freeq_sdk::canonical::canonicalize` on the Rust side — key order sorted
 * by UTF-16 code units, no whitespace, JSON string escaping.
 */
export declare function canonicalizeForSigning(value: unknown): string;
/**
 * Sign a cert with the creator's ed25519 seed (32 bytes — the same file
 * format `freeq-bot-id --creator-key` reads). Returns a NEW cert with the
 * signature attached. The creator must have registered this key's public
 * half with the server via MSGSIG for verification to succeed.
 */
export declare function signDelegation(cert: DelegationCert, creatorSeed: Uint8Array): Promise<DelegationCert>;
export interface BuildDelegationOptions {
    /** Bot's did:key — must start with "did:key:". */
    agentDid: string;
    /** Owner's DID, typically did:plc:… */
    ownerDid: string;
}
/** Build a fresh cert. Does NOT persist. */
export declare function buildDelegation(opts: BuildDelegationOptions): DelegationCert;
export interface LoadDelegationOptions {
    /** Absolute path to the cert file. */
    certPath: string;
}
export declare function loadDelegation(opts: LoadDelegationOptions): Promise<DelegationCert | null>;
export interface LoadOrMintDelegationOptions {
    /** Absolute path to the cert file. The parent directory is created if needed. */
    certPath: string;
    agentDid: string;
    ownerDid: string;
    /**
     * Path to the creator's ed25519 seed (32 bytes, mode 0600 — the file
     * `freeq-bot-id --creator-key` reads). When set, freshly minted certs are
     * signed, and an existing UNSIGNED cert is upgraded in place (signed and
     * rewritten). The creator must have registered this key via MSGSIG.
     */
    creatorKeyPath?: string;
}
/** Mint a new cert if none exists, otherwise return the existing one
 *  (upgrading it to signed when a creator key is provided). */
export declare function loadOrMintDelegation(opts: LoadOrMintDelegationOptions): Promise<DelegationCert>;
//# sourceMappingURL=delegation.d.ts.map