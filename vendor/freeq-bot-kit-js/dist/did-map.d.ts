/** Discriminated source: file (auto-watched), function (manual reload), or
 *  a static array (no reload). */
export type DidMapSource<T> = {
    path: string;
    parse: (raw: string) => T[];
} | (() => Promise<T[]>) | T[];
export type DidMapSave<T> = (entries: T[]) => Promise<void>;
export interface DidMapBaseOptions<T extends {
    did: string;
}> {
    load: DidMapSource<T>;
    /** mtime-poll interval for file sources. Ignored for function/array
     *  sources. Default 2000ms. */
    pollMs?: number;
}
export interface DidMapMutableOptions<T extends {
    did: string;
}> extends DidMapBaseOptions<T> {
    /** Persist callback invoked after every successful `set`/`delete`. Caller
     *  owns the write semantics (atomic JSON write, DB UPDATE, etc.). */
    save: DidMapSave<T>;
}
export interface DidMapReadOnly<T extends {
    did: string;
}> {
    /** Membership predicate. */
    has(did: string): boolean;
    /** Entry for `did`, or null. */
    get(did: string): T | null;
    /** Snapshot copy of current entries. */
    list(): T[];
    /** Force a re-read. For file sources this re-runs `parse(readFile())`;
     *  for function sources it re-runs the loader; for arrays it's a no-op. */
    reload(): Promise<void>;
    /** Subscribe to entries-changed events (file reload, function reload,
     *  set, delete). Returns a disposer. */
    onChange(cb: (entries: T[]) => void): () => void;
    /** Stop polling, drop subscribers. The map's getters keep working with
     *  the last-known state, but nothing will refresh them. */
    close(): void;
}
export interface DidMapMutable<T extends {
    did: string;
}> extends DidMapReadOnly<T> {
    /** Upsert by DID. Awaits `save(newEntries)` before mutating in-memory;
     *  rejects if save throws (in-memory state stays unchanged). */
    set(entry: T): Promise<void>;
    /** Remove by DID. Returns false if the DID wasn't present (no save call,
     *  no state change). */
    delete(did: string): Promise<boolean>;
}
/** With `save`: full CRUD. */
export declare function createDidMap<T extends {
    did: string;
}>(opts: DidMapMutableOptions<T>): Promise<DidMapMutable<T>>;
/** Without `save`: read-only-with-reload. */
export declare function createDidMap<T extends {
    did: string;
}>(opts: DidMapBaseOptions<T>): Promise<DidMapReadOnly<T>>;
//# sourceMappingURL=did-map.d.ts.map