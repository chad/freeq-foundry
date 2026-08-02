/**
 * The raw-file escape hatch.
 *
 * Two full sessions produced zero lines of code from agents that held repo.commit, had
 * read the spec, and were being nudged every 45 seconds. The suspected cause is that a
 * whole source file embedded in a JSON string is a coin flip: one unescaped newline or
 * quote and the turn is discarded as malformed, which looks exactly like an agent that
 * decided to keep talking instead.
 */
import { describe, expect, it } from "vitest";
import { inlineRawFiles } from "./agent.js";

const decision = (content: string) => ({
  reasoning: "shipping",
  actions: [
    { tool: "write_file", args: { path: "src/core.mjs", content } },
    { tool: "run_tests", args: {} },
  ],
});

describe("inlineRawFiles", () => {
  it("splices a raw body into the placeholder action", () => {
    const raw = [
      '{"reasoning":"shipping","actions":[{"tool":"write_file","args":{"path":"src/core.mjs","content":"<<<FILE>>>"}}]}',
      "<<<FILE>>>",
      'export function score(x) {',
      '  return `${x * 2}`;   // backticks, quotes, newlines — all fatal inside JSON',
      "}",
      "<<<END>>>",
    ].join("\n");
    const out = inlineRawFiles(decision("<<<FILE>>>"), raw);
    const content = (out.actions[0] as { args: { content: string } }).args.content;
    expect(content).toContain("export function score");
    expect(content).toContain("${x * 2}");
    expect(content.startsWith("export")).toBe(true);
    expect(content.endsWith("}")).toBe(true);
  });

  it("leaves ordinary actions untouched", () => {
    const out = inlineRawFiles(decision("export const a = 1;"), "no markers here");
    expect((out.actions[0] as { args: { content: string } }).args.content).toBe("export const a = 1;");
    expect(out.actions).toHaveLength(2);
  });

  it("tolerates a missing end marker", () => {
    const raw = '{"actions":[]}\n<<<FILE>>>\nexport const x = 1;';
    const content = (inlineRawFiles(decision("<<<FILE>>>"), raw).actions[0] as { args: { content: string } })
      .args.content;
    expect(content).toBe("export const x = 1;");
  });

  it("ignores an empty body rather than writing an empty file", () => {
    const raw = "{}\n<<<FILE>>>\n\n<<<END>>>";
    expect((inlineRawFiles(decision("<<<FILE>>>"), raw).actions[0] as { args: { content: string } })
      .args.content).toBe("<<<FILE>>>");
  });
});
