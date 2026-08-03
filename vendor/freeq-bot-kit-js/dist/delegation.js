// FreeqBotDelegation/v1 cert.
//
// Signed when the creator's ed25519 key is available (`creatorKeyPath`, a
// 32-byte seed file — the same format `freeq-bot-id --creator-key` reads):
// the cert is JCS-canonicalized (RFC 8785) with the `signature` field
// omitted and ed25519-signed, exactly mirroring freeq-bot-id/src/main.rs.
// The server (connection/provenance.rs) verifies against the creator's
// registered MSGSIG public key, so the creator must have registered that
// key's public half via MSGSIG for the cert to show `_verified: true`.
//
// Without a creator key the cert ships unsigned (signature: null) — the
// server stores it as _verified: false with reason "Cert has no signature;
// declarative only".
import { importDidKey } from "@freeq/sdk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
/**
 * RFC 8785 (JCS) canonicalization, restricted to the value shapes a
 * delegation cert can contain: objects, arrays, strings, booleans, null,
 * and safe integers. Must produce byte-identical output to
 * `freeq_sdk::canonical::canonicalize` on the Rust side — key order sorted
 * by UTF-16 code units, no whitespace, JSON string escaping.
 */
export function canonicalizeForSigning(value) {
    if (value === null)
        return "null";
    switch (typeof value) {
        case "string":
            return JSON.stringify(value);
        case "boolean":
            return value ? "true" : "false";
        case "number":
            if (!Number.isSafeInteger(value)) {
                throw new Error(`canonicalizeForSigning: non-integer number ${value} unsupported`);
            }
            return String(value);
        case "object": {
            if (Array.isArray(value)) {
                return `[${value.map(canonicalizeForSigning).join(",")}]`;
            }
            const obj = value;
            const keys = Object.keys(obj)
                .filter((k) => obj[k] !== undefined)
                .sort();
            const body = keys
                .map((k) => `${JSON.stringify(k)}:${canonicalizeForSigning(obj[k])}`)
                .join(",");
            return `{${body}}`;
        }
        default:
            throw new Error(`canonicalizeForSigning: unsupported type ${typeof value}`);
    }
}
/**
 * Sign a cert with the creator's ed25519 seed (32 bytes — the same file
 * format `freeq-bot-id --creator-key` reads). Returns a NEW cert with the
 * signature attached. The creator must have registered this key's public
 * half with the server via MSGSIG for verification to succeed.
 */
export async function signDelegation(cert, creatorSeed) {
    // Canonical form: the cert WITHOUT the signature field, matching both
    // freeq-bot-id sign-time behavior and the server's verify-time removal.
    const { signature: _omit, ...unsigned } = cert;
    const canonical = canonicalizeForSigning(unsigned);
    const key = await importDidKey(creatorSeed);
    const signature = await key.signer(new TextEncoder().encode(canonical));
    return { ...cert, signature };
}
/** Build a fresh cert. Does NOT persist. */
export function buildDelegation(opts) {
    const { agentDid, ownerDid } = opts;
    const bot_public_key = agentDid.replace(/^did:key:/, "");
    if (bot_public_key === agentDid) {
        throw new Error(`agentDid does not start with did:key: — got ${agentDid}. v1.0 only supports did:key bots.`);
    }
    return {
        type: "FreeqBotDelegation/v1",
        bot_did: agentDid,
        bot_public_key,
        creator_did: ownerDid,
        created_at: new Date().toISOString(),
        revocation_authority: ownerDid,
        signature: null,
    };
}
export async function loadDelegation(opts) {
    const { certPath } = opts;
    let raw;
    try {
        raw = await readFile(certPath, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return null;
        throw err;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error(`${certPath} is not valid JSON. Delete it to regenerate, or fix the file.`);
    }
    if (parsed.type !== "FreeqBotDelegation/v1") {
        throw new Error(`${certPath} has type ${parsed.type}; expected FreeqBotDelegation/v1.`);
    }
    return parsed;
}
async function readCreatorSeed(path) {
    const buf = await readFile(path);
    if (buf.length !== 32) {
        throw new Error(`${path} is ${buf.length} bytes, expected 32 (ed25519 seed for delegation signing).`);
    }
    return new Uint8Array(buf);
}
/** Mint a new cert if none exists, otherwise return the existing one
 *  (upgrading it to signed when a creator key is provided). */
export async function loadOrMintDelegation(opts) {
    const { certPath, agentDid, ownerDid, creatorKeyPath } = opts;
    const existing = await loadDelegation({ certPath });
    if (existing) {
        // Sanity: an existing cert must match the current agent + owner identity.
        // Mismatch usually means the user changed handle or regenerated the seed.
        if (existing.bot_did !== agentDid) {
            throw new Error(`Stored delegation bot_did (${existing.bot_did}) does not match current agent (${agentDid}). Delete ${certPath} to regenerate.`);
        }
        if (existing.creator_did !== ownerDid) {
            throw new Error(`Stored delegation creator_did (${existing.creator_did}) does not match current owner (${ownerDid}). Delete ${certPath} to regenerate.`);
        }
        if (!existing.signature && creatorKeyPath) {
            const signed = await signDelegation(existing, await readCreatorSeed(creatorKeyPath));
            await writeFile(certPath, JSON.stringify(signed, null, 2) + "\n", { mode: 0o600 });
            return signed;
        }
        return existing;
    }
    let cert = buildDelegation({ agentDid, ownerDid });
    if (creatorKeyPath) {
        cert = await signDelegation(cert, await readCreatorSeed(creatorKeyPath));
    }
    await mkdir(dirname(certPath), { recursive: true, mode: 0o700 });
    await writeFile(certPath, JSON.stringify(cert, null, 2) + "\n", { mode: 0o600 });
    return cert;
}
//# sourceMappingURL=delegation.js.map