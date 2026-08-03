import { FreeqClient, type FreeqEvents, type NickCollisionPolicy } from "@freeq/sdk";
import { type AgentIdentity } from "./identity.js";
import { type DelegationCert } from "./delegation.js";
import { type ResolveOpts } from "./did-resolver.js";
/** Result of `bot.checkMention(channel, text)`. */
export type MentionResult = {
    kind: "ignore";
} | {
    kind: "cooldown";
    remainingMs: number;
} | {
    kind: "respond";
    stripped: string;
};
/** Signature for the caller-supplied mention matcher. Receives the message
 *  text and the bot's current nick; returns the stripped text on match,
 *  or `null` to ignore. */
export type MentionMatcher = (text: string, nick: string) => string | null;
export type ActorClass = "agent" | "external_agent" | "human";
export interface FreeqBotCreateOptions {
    /** Bot name — scopes state under `~/.freeq/bots/<name>/`. */
    name: string;
    /** Owner DID (e.g. `did:plc:…`). Caller-resolved. */
    ownerDid: string;
    /** IRC nickname to register with. */
    nick: string;
    /** WebSocket URL, e.g. `wss://irc.freeq.at/irc`. */
    url: string;
    /** Override the parent dir for bot state. Defaults to `~/.freeq/bots`. */
    root?: string;
    /** Path to the owner's ed25519 seed (32 bytes; the file `freeq-bot-id
     *  --creator-key` reads). When set, the delegation cert is SIGNED by the
     *  owner — the server shows `_verified: true` provided the owner has
     *  registered this key via MSGSIG. Unset → unsigned/declarative cert. */
    creatorKeyPath?: string;
    /** Actor class declared via AGENT REGISTER. Default `"agent"`. */
    actorClass?: ActorClass;
    /** Initial PRESENCE state. Default `"active"`. Carried by heartbeats
     *  until `setState()` changes it. */
    initialState?: string;
    /** Optional initial status string for PRESENCE. */
    initialStatus?: string;
    /** TOML manifest. If set, announce sends `AGENT MANIFEST` after REGISTER. */
    manifest?: string;
    /** Channels to auto-join on connect. */
    channels?: string[];
    /** Heartbeat interval (ms). Default 30_000. */
    heartbeatMs?: number;
    /** Heartbeat TTL (seconds). Default 60. */
    heartbeatTtlS?: number;
    /** Server origin for REST API calls. Defaults to the URL origin. */
    serverOrigin?: string;
    /** Policy on 433 ERR_NICKNAMEINUSE. Default `"refuse"`. */
    onNickCollision?: NickCollisionPolicy;
    /** Sender-DID resolver tuning. Sets defaults on the per-bot resolver
     *  used by `bot.resolveSenderDid()`. Override per-call via the
     *  method's `opts` argument. */
    senderDidResolver?: {
        /** Default WHOIS race timeout in ms. Default 3000. */
        timeoutMs?: number;
        /** Cache entries expire this many ms after insert. Default 300_000
         *  (5 min). The cache may miss invalidation events for DM-only
         *  users; TTL bounds staleness regardless. */
        cacheTtlMs?: number;
    };
    /** Channel-mention tuning for `bot.checkMention()`. */
    mention?: {
        /** Per-channel cooldown in ms. After a `respond` on a channel,
         *  subsequent addressed messages on the same channel return
         *  `cooldown` until this elapses. Default 60_000. Set to 0 to
         *  disable. */
        cooldownMs?: number;
        /** Override the default addressing rule. Receives the message text
         *  and the bot's current nick; returns the stripped text on match,
         *  or `null` to ignore. Default matches `@<nick>` or `<nick>:`/
         *  `<nick>,` anywhere (with word boundary). */
        matcher?: (text: string, nick: string) => string | null;
    };
}
export interface FreeqBotStartOptions {
    /** Reject `start()` if `'ready'` isn't reached within this many ms.
     *  Default 30_000. */
    timeoutMs?: number;
}
export interface FreeqBotStopOptions {
    /** QUIT reason. Defaults to `"shutting down"`. */
    reason?: string;
    /** How long to wait after PRESENCE=offline/QUIT before disconnecting.
     *  Default 250ms. */
    drainMs?: number;
}
export declare class FreeqBot {
    #private;
    /** Underlying SDK client — `bot.on(...)` proxies handlers here. For typed
     *  methods not surfaced on FreeqBot, call `bot.client.foo(...)`. */
    readonly client: FreeqClient;
    /** Resolved did:key identity. */
    readonly identity: AgentIdentity;
    /** FreeqBotDelegation/v1 cert binding identity to owner. */
    readonly delegation: DelegationCert;
    /** Absolute path under which this bot's state lives. */
    readonly stateDir: string;
    /** Use `FreeqBot.create(...)` instead. */
    private constructor();
    /** Async factory: loads/creates identity + cert from disk, constructs the
     *  FreeqClient with crypto SASL, returns a ready-to-`.start()` bot. */
    static create(opts: FreeqBotCreateOptions): Promise<FreeqBot>;
    /** Register a handler. Typed delegation to `client.on`. */
    on<K extends keyof FreeqEvents>(event: K, handler: FreeqEvents[K]): this;
    /** Unregister a handler. */
    off<K extends keyof FreeqEvents>(event: K, handler: FreeqEvents[K]): this;
    /** Register a one-shot handler. */
    once<K extends keyof FreeqEvents>(event: K, handler: FreeqEvents[K]): this;
    /** Update the bot's current state. Sends an immediate PRESENCE update and
     *  causes subsequent heartbeats to carry the new state.
     *
     *  Valid states include: `online`, `idle`, `active`, `executing`,
     *  `waiting_for_input`, `blocked_on_permission`, `blocked_on_budget`,
     *  `degraded`, `paused`, `sandboxed`, `revoked`, `offline`. */
    setState(state: string, status?: string, task?: string): void;
    /** Read the bot's current state (last value passed to `setState()`). */
    get state(): string;
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
    resolveSenderDid(msg: {
        from: string;
        tags?: Record<string, string>;
    }, opts?: ResolveOpts): Promise<string | null>;
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
    checkMention(channel: string, text: string): MentionResult;
    /** Connect, await `'ready'`, run the announce sequence + heartbeat loop.
     *  Rejects on SASL failure, pre-ready disconnect, or timeout. */
    start(opts?: FreeqBotStartOptions): Promise<void>;
    /** Graceful shutdown: stop heartbeat, send PRESENCE=offline + QUIT,
     *  wait for the WebSocket send buffer to drain, then disconnect.
     *  Idempotent.
     *
     *  Note: the server applies a 30-second ghost period to DID-authenticated
     *  sessions (`QUIT_GRACE_SECS` in connection/mod.rs). The bot's channel
     *  membership is preserved for ~30s after disconnect so a quick
     *  reconnect doesn't churn JOIN/QUIT. To other clients, this looks like
     *  the bot lingering after shutdown — it's intentional server-side. */
    stop(opts?: FreeqBotStopOptions | string): Promise<void>;
}
//# sourceMappingURL=bot.d.ts.map