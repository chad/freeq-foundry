export function createDidResolver(client, opts = {}) {
    const defaultTimeoutMs = opts.timeoutMs ?? 3000;
    const cacheTtlMs = opts.cacheTtlMs ?? 5 * 60_000;
    const cache = new Map();
    const pending = new Map();
    const onMemberDid = (nick, did) => {
        cache.set(nick.toLowerCase(), { did, expiresAt: Date.now() + cacheTtlMs });
    };
    const onUserRenamed = (from) => {
        cache.delete(from.toLowerCase());
    };
    const onUserQuit = (from) => {
        cache.delete(from.toLowerCase());
    };
    client.on("memberDid", onMemberDid);
    client.on("userRenamed", onUserRenamed);
    client.on("userQuit", onUserQuit);
    function getCached(nick) {
        const key = nick.toLowerCase();
        const e = cache.get(key);
        if (!e)
            return null;
        if (e.expiresAt <= Date.now()) {
            cache.delete(key);
            return null;
        }
        return e.did;
    }
    function whoisAndWait(nick, timeoutMs) {
        const key = nick.toLowerCase();
        const existing = pending.get(key);
        if (existing)
            return existing;
        const promise = new Promise((resolve) => {
            let settled = false;
            const settle = (value) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                client.off("memberDid", listener);
                pending.delete(key);
                resolve(value);
            };
            const listener = (gotNick, did) => {
                if (gotNick.toLowerCase() !== key)
                    return;
                settle(did);
            };
            const timer = setTimeout(() => settle(null), timeoutMs);
            // Don't keep the event loop alive just for this timer.
            timer.unref?.();
            client.on("memberDid", listener);
            client.raw(`WHOIS ${nick}`);
        });
        pending.set(key, promise);
        return promise;
    }
    return {
        async resolve(msg, callOpts = {}) {
            // 1. account-tag (always preferred; authoritative for the message)
            const tag = msg.tags?.account;
            if (tag && tag.startsWith("did:"))
                return tag;
            const useCache = callOpts.cache ?? true;
            const useWhois = callOpts.whois ?? true;
            const timeoutMs = callOpts.timeoutMs ?? defaultTimeoutMs;
            // 2. cache (unless disabled)
            if (useCache) {
                const cached = getCached(msg.from);
                if (cached)
                    return cached;
            }
            // 3. WHOIS (unless disabled)
            if (useWhois) {
                return whoisAndWait(msg.from, timeoutMs);
            }
            return null;
        },
        close() {
            client.off("memberDid", onMemberDid);
            client.off("userRenamed", onUserRenamed);
            client.off("userQuit", onUserQuit);
            cache.clear();
            pending.clear();
        },
    };
}
//# sourceMappingURL=did-resolver.js.map