// FreeqBot — high-level wrapper over @freeq/sdk's FreeqClient.
//
// Owns the boilerplate every bot needs:
//   - load / persist did:key identity (32-byte ed25519 seed)
//   - load / mint FreeqBotDelegation/v1 cert
//   - run the announce sequence (PROVENANCE → AGENT REGISTER → MANIFEST? →
//     PRESENCE → HEARTBEAT loop) on every `'ready'`, so reconnects re-announce
//   - own current presence/heartbeat state via `setState()`
//   - reject `start()` on auth failures / pre-ready disconnects / timeout
//
// Construction is async (the SDK's did-key derivation uses Web Crypto).
// Use the static factory: `await FreeqBot.create({...})`.
//
// Shape modeled on discord.js / bolt-js / telegraf / grammY:
//   - events register on the bot directly via `bot.on(...)` (typed delegation
//     to the underlying client)
//   - `.client` exposes the FreeqClient for anything not on the wrapper
//   - the framework does NOT install SIGINT/SIGTERM handlers — README shows
//     the snippet for the caller to wire it themselves
import { FreeqClient, } from "@freeq/sdk";
import { join } from "node:path";
import { botDir } from "./paths.js";
import { loadOrCreateIdentity } from "./identity.js";
import { loadOrMintDelegation } from "./delegation.js";
import { createDidResolver, } from "./did-resolver.js";
import { matchMention } from "./mention.js";
export class FreeqBot {
    /** Underlying SDK client — `bot.on(...)` proxies handlers here. For typed
     *  methods not surfaced on FreeqBot, call `bot.client.foo(...)`. */
    client;
    /** Resolved did:key identity. */
    identity;
    /** FreeqBotDelegation/v1 cert binding identity to owner. */
    delegation;
    /** Absolute path under which this bot's state lives. */
    stateDir;
    #actorClass;
    #manifest;
    #heartbeatMs;
    #heartbeatTtlS;
    #currentState;
    #currentStatus;
    #currentTask;
    #heartbeatTimer = null;
    #readyHandler = null;
    #started = false;
    #stopped = false;
    #didResolver;
    #mentionCooldownMs;
    #mentionMatcher;
    #mentionLastRespond = new Map(); // channel.toLowerCase() → ms
    /** Use `FreeqBot.create(...)` instead. */
    constructor(args) {
        this.client = args.client;
        this.identity = args.identity;
        this.delegation = args.delegation;
        this.stateDir = args.stateDir;
        this.#actorClass = args.actorClass;
        this.#manifest = args.manifest;
        this.#heartbeatMs = args.heartbeatMs;
        this.#heartbeatTtlS = args.heartbeatTtlS;
        this.#currentState = args.initialState;
        this.#currentStatus = args.initialStatus;
        this.#didResolver = createDidResolver(this.client, {
            timeoutMs: args.didResolverTimeoutMs,
            cacheTtlMs: args.didResolverCacheTtlMs,
        });
        this.#mentionCooldownMs = args.mentionCooldownMs;
        this.#mentionMatcher = args.mentionMatcher;
    }
    /** Async factory: loads/creates identity + cert from disk, constructs the
     *  FreeqClient with crypto SASL, returns a ready-to-`.start()` bot. */
    static async create(opts) {
        const stateDir = await botDir(opts.name, { root: opts.root });
        const identity = await loadOrCreateIdentity({
            seedPath: join(stateDir, "agent.key"),
        });
        const delegation = await loadOrMintDelegation({
            certPath: join(stateDir, "delegation.json"),
            agentDid: identity.did,
            ownerDid: opts.ownerDid,
            creatorKeyPath: opts.creatorKeyPath,
        });
        const client = new FreeqClient({
            url: opts.url,
            nick: opts.nick,
            channels: opts.channels,
            serverOrigin: opts.serverOrigin,
            onNickCollision: opts.onNickCollision ?? "refuse",
            sasl: {
                did: identity.did,
                method: "crypto",
                signer: identity.didKey.signer,
                token: "",
                pdsUrl: "",
            },
            // The bot has its own long-lived ed25519 identity (its did:key); skip
            // the SDK's auto-mint of a per-session MSGSIG key. The server will
            // server-sign outbound messages on our behalf when the client doesn't
            // attach a signature.
            autoMsgSig: false,
        });
        const defaultMentionMatcher = (text, nick) => {
            const r = matchMention(nick, text);
            return r ? r.stripped : null;
        };
        return new FreeqBot({
            client,
            identity,
            delegation,
            stateDir,
            actorClass: opts.actorClass ?? "agent",
            manifest: opts.manifest,
            heartbeatMs: opts.heartbeatMs ?? 30_000,
            heartbeatTtlS: opts.heartbeatTtlS ?? 60,
            initialState: opts.initialState ?? "active",
            initialStatus: opts.initialStatus,
            didResolverTimeoutMs: opts.senderDidResolver?.timeoutMs,
            didResolverCacheTtlMs: opts.senderDidResolver?.cacheTtlMs,
            mentionCooldownMs: opts.mention?.cooldownMs ?? 60_000,
            mentionMatcher: opts.mention?.matcher ?? defaultMentionMatcher,
        });
    }
    // ── Typed event delegation ─────────────────────────────────────────────
    /** Register a handler. Typed delegation to `client.on`. */
    on(event, handler) {
        this.client.on(event, handler);
        return this;
    }
    /** Unregister a handler. */
    off(event, handler) {
        this.client.off(event, handler);
        return this;
    }
    /** Register a one-shot handler. */
    once(event, handler) {
        this.client.once(event, handler);
        return this;
    }
    // ── State management ───────────────────────────────────────────────────
    /** Update the bot's current state. Sends an immediate PRESENCE update and
     *  causes subsequent heartbeats to carry the new state.
     *
     *  Valid states include: `online`, `idle`, `active`, `executing`,
     *  `waiting_for_input`, `blocked_on_permission`, `blocked_on_budget`,
     *  `degraded`, `paused`, `sandboxed`, `revoked`, `offline`. */
    setState(state, status, task) {
        this.#currentState = state;
        this.#currentStatus = status;
        this.#currentTask = task;
        try {
            this.client.setPresence(state, status, task);
        }
        catch {
            // Socket may be down; next 'ready' will re-announce with current state.
        }
    }
    /** Read the bot's current state (last value passed to `setState()`). */
    get state() {
        return this.#currentState;
    }
    // ── Sender DID resolution ──────────────────────────────────────────────
    /** Resolve the sender's DID for a PRIVMSG. Returns null if the message
     *  has no account-tag, the cache doesn't know the sender, and WHOIS
     *  times out (or is disabled).
     *
     *  Sources, in priority order:
     *    1. `msg.tags.account` — authoritative for the message
     *    2. nick→DID cache (populated automatically by `memberDid` events;
     *       invalidated by `userRenamed` / `userQuit` and a 5-minute TTL)
     *    3. WHOIS round-trip, raced against `timeoutMs` (default 3000ms)
     *
     *  Use `opts.cache: false` for a fresh lookup every call (no stale
     *  cache); `opts.whois: false` to skip the round-trip; both false for
     *  strict mode (account-tag only). */
    async resolveSenderDid(msg, opts) {
        return this.#didResolver.resolve(msg, opts);
    }
    // ── Channel addressing ─────────────────────────────────────────────────
    /** Classify a channel message as addressed-to-this-bot or not.
     *
     *  Reads the bot's current nick live (so server-side renames are picked
     *  up without re-wiring) and runs the configured matcher. Default
     *  matcher accepts `@<nick>` or `<nick>:`/`<nick>,` anywhere in the
     *  message; callers can pass their own via `FreeqBot.create({mention:
     *  {matcher}})`.
     *
     *  Returns one of:
     *    - `{kind: "ignore"}` — not addressed
     *    - `{kind: "cooldown", remainingMs}` — addressed, but the bot
     *      already responded on this channel within the cooldown window
     *    - `{kind: "respond", stripped}` — bot was addressed; `stripped`
     *      is the message text with the addressing prefix removed
     *
     *  A `respond` result records "now" as the channel's last-respond
     *  timestamp before returning, so the next addressed message on the
     *  same channel within `cooldownMs` returns `cooldown`. Different
     *  channels have independent cooldowns. */
    checkMention(channel, text) {
        const nick = this.client.nick;
        if (!nick)
            return { kind: "ignore" };
        const stripped = this.#mentionMatcher(text, nick);
        if (stripped === null)
            return { kind: "ignore" };
        const key = channel.toLowerCase();
        const now = Date.now();
        if (this.#mentionCooldownMs > 0) {
            const last = this.#mentionLastRespond.get(key);
            if (last !== undefined) {
                const remainingMs = last + this.#mentionCooldownMs - now;
                if (remainingMs > 0)
                    return { kind: "cooldown", remainingMs };
            }
        }
        this.#mentionLastRespond.set(key, now);
        return { kind: "respond", stripped };
    }
    // ── Lifecycle ──────────────────────────────────────────────────────────
    /** Connect, await `'ready'`, run the announce sequence + heartbeat loop.
     *  Rejects on SASL failure, pre-ready disconnect, or timeout. */
    async start(opts = {}) {
        if (this.#started) {
            throw new Error("FreeqBot.start() called more than once");
        }
        this.#started = true;
        const timeoutMs = opts.timeoutMs ?? 30_000;
        // Persistent handler: re-runs on every 'ready' so reconnects re-announce.
        this.#readyHandler = () => this.#announceAndHeartbeat();
        this.client.on("ready", this.#readyHandler);
        this.client.connect();
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`timeout waiting for ready (${timeoutMs}ms)`));
            }, timeoutMs);
            const onReady = () => {
                cleanup();
                resolve();
            };
            const onAuthError = (msg) => {
                cleanup();
                reject(new Error(`SASL auth failed: ${msg}`));
            };
            const onState = (state) => {
                if (state === "disconnected") {
                    cleanup();
                    reject(new Error("disconnected before ready"));
                }
            };
            const onError = (msg) => {
                cleanup();
                reject(new Error(msg));
            };
            const cleanup = () => {
                clearTimeout(timer);
                this.client.off("ready", onReady);
                this.client.off("authError", onAuthError);
                this.client.off("connectionStateChanged", onState);
                this.client.off("error", onError);
            };
            this.client.once("ready", onReady);
            this.client.once("authError", onAuthError);
            this.client.on("connectionStateChanged", onState);
            this.client.once("error", onError);
        });
    }
    /** Graceful shutdown: stop heartbeat, send PRESENCE=offline + QUIT,
     *  wait for the WebSocket send buffer to drain, then disconnect.
     *  Idempotent.
     *
     *  Note: the server applies a 30-second ghost period to DID-authenticated
     *  sessions (`QUIT_GRACE_SECS` in connection/mod.rs). The bot's channel
     *  membership is preserved for ~30s after disconnect so a quick
     *  reconnect doesn't churn JOIN/QUIT. To other clients, this looks like
     *  the bot lingering after shutdown — it's intentional server-side. */
    async stop(opts = {}) {
        if (this.#stopped)
            return;
        this.#stopped = true;
        const { reason = "shutting down", drainMs = 2000 } = typeof opts === "string" ? { reason: opts } : opts;
        if (this.#heartbeatTimer) {
            clearInterval(this.#heartbeatTimer);
            this.#heartbeatTimer = null;
        }
        if (this.#readyHandler) {
            this.client.off("ready", this.#readyHandler);
            this.#readyHandler = null;
        }
        try {
            this.client.setPresence("offline");
            this.client.raw(`QUIT :${reason}`);
        }
        catch {
            // socket may already be gone; nothing to flush
        }
        // Wait for the send buffer to actually drain (poll bufferedAmount).
        // The previous fixed-250ms sleep was racy: process.exit() doesn't wait
        // for in-flight WebSocket writes, so PRESENCE/QUIT could be dropped.
        await this.client.flush(drainMs);
        this.client.disconnect();
        this.#didResolver.close();
    }
    // ── Internal ───────────────────────────────────────────────────────────
    /** Runs on every `'ready'` (initial + each reconnect). */
    #announceAndHeartbeat() {
        // Reset any prior heartbeat — reconnects start fresh.
        if (this.#heartbeatTimer) {
            clearInterval(this.#heartbeatTimer);
            this.#heartbeatTimer = null;
        }
        try {
            this.client.submitProvenance(this.delegation);
            this.client.registerAgent(this.#actorClass);
            if (this.#manifest) {
                this.client.submitManifest(this.#manifest);
            }
            this.client.setPresence(this.#currentState, this.#currentStatus, this.#currentTask);
        }
        catch {
            // Socket likely gone mid-announce; next 'ready' will retry.
            return;
        }
        const beat = () => {
            try {
                this.client.sendHeartbeat(this.#currentState, this.#heartbeatTtlS);
            }
            catch {
                // socket gone; next 'ready' will re-arm
            }
        };
        beat();
        this.#heartbeatTimer = setInterval(beat, this.#heartbeatMs);
    }
}
//# sourceMappingURL=bot.js.map