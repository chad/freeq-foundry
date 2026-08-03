// createDidMap — a hot-reloadable, DID-keyed map.
//
// Three source flavors:
//   - File-backed:  { path, parse }      → auto mtime-poll
//   - Function:     () => Promise<T[]>   → manual .reload()
//   - Static array: T[]                  → never reloads
//
// Mutation (set/delete) is gated on `save` being provided. Without `save`
// the returned object is read-only — no .set/.delete on the type — which
// makes "mutate without persisting" impossible by construction.
//
// What the framework owns:
//   - Initial load
//   - mtime polling for file sources (interval-based; fs.watch is too flaky
//     across platforms and editor save patterns)
//   - Atomic in-memory swap on reload (no torn reads from concurrent
//     .has / .get calls)
//   - ENOENT-as-empty (the file just hasn't been created yet)
//   - Parse-error retention on RELOAD (keep previous good state + warn;
//     initial parse errors still throw because starting with unknown state
//     is worse than starting with empty)
//   - Self-write tracking so a .set() doesn't cause a redundant onChange
//     when the poll subsequently notices the file changed
//
// What the framework does NOT do:
//   - Pick what membership means (allowlist vs banlist vs roles is wiring)
//   - Pick a file format (caller's `parse`/serialization is theirs)
//   - Validate DID syntax (caller's `parse` decides what's valid)
import { readFile, stat } from "node:fs/promises";
export async function createDidMap(opts) {
    const pollMs = opts.pollMs ?? 2000;
    const source = opts.load;
    const isFile = isFileSource(source);
    let entries = [];
    let byDid = new Map();
    const listeners = new Set();
    let pollTimer = null;
    let lastMtime = null;
    const swap = (next) => {
        entries = next;
        byDid = new Map(next.map((e) => [e.did, e]));
        for (const cb of listeners) {
            try {
                cb(entries);
            }
            catch (err) {
                // A bad listener shouldn't break the others.
                // eslint-disable-next-line no-console
                console.warn(`[did-map] onChange listener threw: ${err.message}`);
            }
        }
    };
    const read = async () => {
        if (Array.isArray(source))
            return source;
        if (typeof source === "function")
            return source();
        try {
            const raw = await readFile(source.path, "utf8");
            return source.parse(raw);
        }
        catch (err) {
            if (err.code === "ENOENT")
                return [];
            throw err;
        }
    };
    const refreshMtime = async () => {
        if (!isFile)
            return;
        try {
            const s = await stat(source.path);
            lastMtime = s.mtimeMs;
        }
        catch {
            lastMtime = null;
        }
    };
    // Initial load. Parse errors here propagate — refusing to start with
    // unknown state is safer than starting with empty.
    swap(await read());
    if (isFile)
        await refreshMtime();
    if (isFile) {
        const filePath = source.path;
        pollTimer = setInterval(() => {
            void (async () => {
                let mtime;
                try {
                    const s = await stat(filePath);
                    mtime = s.mtimeMs;
                }
                catch (err) {
                    if (err.code === "ENOENT") {
                        // File deleted. Swap to empty if we had anything.
                        if (lastMtime !== null) {
                            lastMtime = null;
                            swap([]);
                        }
                        return;
                    }
                    // Other stat error: skip this tick.
                    return;
                }
                if (mtime === lastMtime)
                    return;
                try {
                    const fresh = await read();
                    lastMtime = mtime;
                    swap(fresh);
                }
                catch (err) {
                    // Parse error on reload: retain previous state, log once per
                    // failure. Operator notices via the warning; next correct edit
                    // picks up.
                    // eslint-disable-next-line no-console
                    console.warn(`[did-map] reload failed for ${filePath}: ${err.message}. Retaining previous state.`);
                }
            })();
        }, pollMs);
        pollTimer.unref?.();
    }
    const base = {
        has: (did) => byDid.has(did),
        get: (did) => byDid.get(did) ?? null,
        list: () => [...entries],
        reload: async () => {
            const fresh = await read();
            swap(fresh);
            if (isFile)
                await refreshMtime();
        },
        onChange: (cb) => {
            listeners.add(cb);
            return () => {
                listeners.delete(cb);
            };
        },
        close: () => {
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
            listeners.clear();
        },
    };
    if (opts.save) {
        const save = opts.save;
        const mutable = {
            ...base,
            set: async (entry) => {
                const next = entries.filter((e) => e.did !== entry.did);
                next.push(entry);
                await save(next);
                swap(next);
                // Re-baseline the mtime so the next poll doesn't see our own write
                // as a change and trigger a redundant onChange.
                if (isFile)
                    await refreshMtime();
            },
            delete: async (did) => {
                if (!byDid.has(did))
                    return false;
                const next = entries.filter((e) => e.did !== did);
                await save(next);
                swap(next);
                if (isFile)
                    await refreshMtime();
                return true;
            },
        };
        return mutable;
    }
    return base;
}
// ── Helpers ────────────────────────────────────────────────────────────
function isFileSource(s) {
    return typeof s === "object" && !Array.isArray(s) && "path" in s;
}
//# sourceMappingURL=did-map.js.map