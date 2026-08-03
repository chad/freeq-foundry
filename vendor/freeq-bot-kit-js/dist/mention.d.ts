/** The default `matcher` for FreeqBot.checkMention. Returns the message
 *  text with the addressing prefix stripped, or null if the bot was not
 *  addressed under the default rules. */
export declare function matchMention(nick: string, text: string): {
    stripped: string;
} | null;
//# sourceMappingURL=mention.d.ts.map