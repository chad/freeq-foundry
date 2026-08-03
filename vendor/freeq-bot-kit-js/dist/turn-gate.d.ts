/** Serializable snapshot of the gate's internal state. Maps are flat
 *  arrays of pairs so JSON.stringify works without a replacer. */
export interface TurnGateState {
    /** sender refusal-key → ms timestamp of the most recent refusal */
    lastRefusalAt: Array<[string, number]>;
    /** Global last-dispatch timestamp (for dispatch-to-dispatch cooldown) */
    lastDispatchAt: number;
    /** Sliding-window of dispatch timestamps within the last hour */
    dispatchTimestamps: number[];
    /** sender DID → dispatch timestamps within cyclePolicy.windowMs */
    perPeerDispatches: Array<[string, number[]]>;
    /** sender DID → backoff-until timestamp (after a cycle trip) */
    cycleBackoffUntil: Array<[string, number]>;
}
export interface CyclePolicy {
    /** Rolling window for counting per-peer dispatches. Default 5 min. */
    windowMs: number;
    /** Max dispatches per peer in the window before tripping backoff. Default 10. */
    turnCap: number;
    /** Silence duration after trip. Default 10 min. */
    backoffMs: number;
}
export interface CreateTurnGateOptions {
    /** Load initial state at startup. Omit to start with empty state. */
    load?: () => Promise<TurnGateState>;
    /** Persist current state. Omit to skip persistence entirely. */
    save?: (state: TurnGateState) => Promise<void>;
    /** Dispatch-to-dispatch cooldown in ms. Default 0 (disabled). */
    cooldownMs?: number;
    /** Rolling 60-minute dispatch cap. Default 30. */
    hourlyCap?: number;
    /** How long after refusing a sender to be silent before refusing
     *  again. Default 3,600,000 ms (1 hour). */
    refusalCooldownMs?: number;
    /** Per-peer cycle detection. Default {5min, 10, 10min}. */
    cyclePolicy?: CyclePolicy;
}
export interface EvaluateArgs {
    /** Sender's DID, or null if not authenticated / not yet resolved. */
    senderDid: string | null;
    /** Sender's nick, used for the refusal key when DID is null. */
    senderNick: string;
    /** If set, the caller wants to refuse this sender. The gate handles
     *  the refuse-once-then-silent cooldown — returns `refuse(reason)`
     *  the first time, `silent` for subsequent attempts within
     *  refusalCooldownMs. */
    refusalReason?: string;
    /** Skip per-peer cycle detection for this sender. Useful for
     *  trusted senders (owner) who shouldn't trip backoff. */
    skipCycleDetection?: boolean;
    /** Inject the current time for tests. Defaults to `Date.now()`. */
    now?: number;
}
export type GateDecision = {
    kind: "dispatch";
} | {
    kind: "refuse";
    reason: string;
} | {
    kind: "silent";
};
export interface TurnGate {
    /** Synchronous: returns the decision immediately. Mutates internal
     *  state (refusal timestamps, dispatch records, cycle backoff). */
    evaluate(args: EvaluateArgs): GateDecision;
    /** Async: serializes internal state to TurnGateState and calls the
     *  configured `save` callback. No-op if `save` wasn't provided. */
    persist(): Promise<void>;
    /** Synchronous: returns a snapshot of current state (for tests /
     *  custom persistence paths). */
    snapshot(): TurnGateState;
}
export declare function createTurnGate(opts?: CreateTurnGateOptions): Promise<TurnGate>;
//# sourceMappingURL=turn-gate.d.ts.map