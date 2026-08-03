// createTurnGate — rate-limit + cycle-detection for bot dispatches.
//
// Decides, per incoming request, whether to dispatch, refuse, or stay
// silent. Three layered rules:
//
//   1. Dispatch-to-dispatch cooldown — at most one dispatch every
//      `cooldownMs`. Off by default (LLM latency naturally rate-limits
//      chat bots; only useful for non-LLM bots or paranoid setups).
//   2. Rolling hourly cap — at most `hourlyCap` dispatches in any
//      60-minute window. Default 30.
//   3. Per-peer cycle detection — if the same counterparty back-and-
//      forths more than `cyclePolicy.turnCap` times in
//      `cyclePolicy.windowMs`, force a `cyclePolicy.backoffMs` silence
//      on that peer.
//
// Caller decides who's allowed. The gate only handles rate-limit and
// the refuse-once-then-silent pattern: pass `refusalReason` when the
// caller wants to refuse, and the gate handles the cooldown so the
// bot doesn't say "no" repeatedly.
//
// Persistence is opt-in via `load` and `save` callbacks (same pattern
// as createDidMap): bot-kit never touches the filesystem. State is
// JSON-serializable so callers can write to a file (with their own
// atomic-write helper), a DB, etc. Omit both callbacks for in-memory
// mode — state resets on restart.
const DEFAULT_CYCLE = {
    windowMs: 5 * 60_000,
    turnCap: 10,
    backoffMs: 10 * 60_000,
};
export async function createTurnGate(opts = {}) {
    const cooldownMs = opts.cooldownMs ?? 0;
    const hourlyCap = opts.hourlyCap ?? 30;
    const refusalCooldownMs = opts.refusalCooldownMs ?? 60 * 60_000;
    const cyclePolicy = opts.cyclePolicy ?? DEFAULT_CYCLE;
    // Internal state — Maps for O(1) keyed access. Serialized to flat
    // arrays-of-pairs via snapshot().
    let lastRefusalAt = new Map();
    let lastDispatchAt = 0;
    let dispatchTimestamps = [];
    let perPeerDispatches = new Map();
    let cycleBackoffUntil = new Map();
    if (opts.load) {
        const loaded = await opts.load();
        lastRefusalAt = new Map(loaded.lastRefusalAt ?? []);
        lastDispatchAt = loaded.lastDispatchAt ?? 0;
        dispatchTimestamps = [...(loaded.dispatchTimestamps ?? [])];
        perPeerDispatches = new Map(loaded.perPeerDispatches ?? []);
        cycleBackoffUntil = new Map(loaded.cycleBackoffUntil ?? []);
    }
    function refusalKey(senderDid, senderNick) {
        return senderDid ?? `unknown:${senderNick.toLowerCase()}`;
    }
    function snapshot() {
        return {
            lastRefusalAt: Array.from(lastRefusalAt.entries()),
            lastDispatchAt,
            dispatchTimestamps: [...dispatchTimestamps],
            perPeerDispatches: Array.from(perPeerDispatches.entries()).map(([k, v]) => [k, [...v]]),
            cycleBackoffUntil: Array.from(cycleBackoffUntil.entries()),
        };
    }
    return {
        evaluate(args) {
            const now = args.now ?? Date.now();
            const rkey = refusalKey(args.senderDid, args.senderNick);
            // ── refusal path ─────────────────────────────────────────────
            if (args.refusalReason !== undefined) {
                const last = lastRefusalAt.get(rkey);
                if (last !== undefined && now - last < refusalCooldownMs) {
                    return { kind: "silent" };
                }
                lastRefusalAt.set(rkey, now);
                return { kind: "refuse", reason: args.refusalReason };
            }
            // ── dispatch path ────────────────────────────────────────────
            // Dispatch-to-dispatch cooldown (first dispatch always passes).
            if (lastDispatchAt > 0 && now - lastDispatchAt < cooldownMs) {
                return { kind: "silent" };
            }
            // Rolling hourly cap.
            const oneHourAgo = now - 60 * 60_000;
            dispatchTimestamps = dispatchTimestamps.filter((t) => t > oneHourAgo);
            if (dispatchTimestamps.length >= hourlyCap) {
                return { kind: "silent" };
            }
            // Per-peer cycle detection (DID-keyed; skipped if caller asks).
            if (args.senderDid !== null && !args.skipCycleDetection) {
                const backoffUntil = cycleBackoffUntil.get(args.senderDid) ?? 0;
                if (now < backoffUntil)
                    return { kind: "silent" };
                const cutoff = now - cyclePolicy.windowMs;
                const recent = (perPeerDispatches.get(args.senderDid) ?? []).filter((t) => t > cutoff);
                if (recent.length >= cyclePolicy.turnCap) {
                    // Trip — silence this peer for backoffMs and reset their counter.
                    cycleBackoffUntil.set(args.senderDid, now + cyclePolicy.backoffMs);
                    perPeerDispatches.set(args.senderDid, []);
                    return { kind: "silent" };
                }
                recent.push(now);
                perPeerDispatches.set(args.senderDid, recent);
            }
            // Reserve the dispatch slot.
            lastDispatchAt = now;
            dispatchTimestamps.push(now);
            return { kind: "dispatch" };
        },
        async persist() {
            if (!opts.save)
                return;
            await opts.save(snapshot());
        },
        snapshot,
    };
}
//# sourceMappingURL=turn-gate.js.map