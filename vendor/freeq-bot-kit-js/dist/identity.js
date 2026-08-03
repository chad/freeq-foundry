// Agent did:key identity, persisted as a 32-byte ed25519 seed file at mode 0600.
//
// First run generates and writes; subsequent runs load and re-derive the same
// did:key. Wraps `@freeq/sdk`'s `generateDidKey` / `importDidKey`.
import { generateDidKey, importDidKey } from "@freeq/sdk";
import { chmod, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
export async function loadOrCreateIdentity(opts) {
    const { seedPath } = opts;
    const seed = await readSeedIfPresent(seedPath);
    if (seed) {
        const didKey = await importDidKey(seed);
        return { did: didKey.did, didKey, isFresh: false };
    }
    const didKey = await generateDidKey();
    const newSeed = await didKey.exportSeed();
    await mkdir(dirname(seedPath), { recursive: true, mode: 0o700 });
    await writeFile(seedPath, newSeed, { mode: 0o600 });
    // Belt and suspenders: enforce 0600 even if the file existed with looser mode.
    await chmod(seedPath, 0o600);
    return { did: didKey.did, didKey, isFresh: true };
}
async function readSeedIfPresent(path) {
    let buf;
    try {
        buf = await readFile(path);
    }
    catch (err) {
        if (err.code === "ENOENT")
            return null;
        throw err;
    }
    if (buf.length !== 32) {
        throw new Error(`${path} is ${buf.length} bytes, expected 32 (ed25519 seed). ` +
            `Delete it to regenerate the agent key, or restore the original.`);
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
//# sourceMappingURL=identity.js.map