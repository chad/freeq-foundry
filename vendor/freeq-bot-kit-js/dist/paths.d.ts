/** Default root: `~/.freeq/bots/`. Override via `botDir({root})` for tests. */
export declare const FREEQ_BOTS_ROOT: string;
export interface BotDirOptions {
    /** Override the parent directory. Defaults to `FREEQ_BOTS_ROOT`. */
    root?: string;
}
/** Return `<root>/<name>/`, creating it with mode 0700. */
export declare function botDir(name: string, opts?: BotDirOptions): Promise<string>;
//# sourceMappingURL=paths.d.ts.map