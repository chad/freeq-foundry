import { describe, expect, it } from "vitest";
import {
  canonicalize,
  canonicalizeToBytes,
  parseStrict,
} from "./canonical.js";
import { ProtocolErrorCode, isProtocolError } from "./errors.js";

function expectRejection(fn: () => unknown, code: ProtocolErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(isProtocolError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
    return;
  }
  throw new Error(`expected ${code} but nothing was thrown`);
}

describe("canonicalize — RFC 8785 conformance", () => {
  it("sorts object keys by UTF-16 code unit", () => {
    expect(canonicalize({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}');
    // Uppercase precedes lowercase in UTF-16, so this is not alphabetical.
    expect(canonicalize({ a: 1, A: 2 })).toBe('{"A":2,"a":1}');
  });

  it("sorts nested objects independently", () => {
    expect(canonicalize({ z: { b: 1, a: 2 }, a: 3 })).toBe(
      '{"a":3,"z":{"a":2,"b":1}}',
    );
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("emits no insignificant whitespace", () => {
    expect(canonicalize({ a: [1, 2], b: { c: true } })).toBe(
      '{"a":[1,2],"b":{"c":true}}',
    );
  });

  it("handles the RFC 8785 key-ordering example", () => {
    // Ordered by UTF-16 code unit, not by locale and not by appearance:
    // \n = 10, '1' = 49, 'a' = 97, '€' = 8364.
    const input = { "\u20ac": 1, "\u000a": 2, a: 3, "1": 4 };
    expect(canonicalize(input)).toBe('{"\\n":2,"1":4,"a":3,"€":1}');
  });

  it("escapes control characters and passes non-ASCII through literally", () => {
    expect(canonicalize({ s: "\u0001\t\n\"\\" })).toBe(
      '{"s":"\\u0001\\t\\n\\"\\\\"}',
    );
    expect(canonicalize({ s: "日本語 café" })).toBe('{"s":"日本語 café"}');
  });

  it("encodes as UTF-8", () => {
    const bytes = canonicalizeToBytes("€");
    expect([...bytes]).toEqual([0x22, 0xe2, 0x82, 0xac, 0x22]);
  });

  it("normalizes -0 to 0", () => {
    expect(canonicalize({ n: -0 })).toBe('{"n":0}');
  });

  it("is stable across differing insertion order", () => {
    const a = canonicalize({ x: 1, y: { p: 1, q: 2 }, z: [1, 2] });
    const b = canonicalize({ z: [1, 2], y: { q: 2, p: 1 }, x: 1 });
    expect(a).toBe(b);
  });
});

describe("canonicalize — ADR-0004 restrictions", () => {
  it("rejects non-integer numbers", () => {
    expectRejection(() => canonicalize({ n: 1.5 }), ProtocolErrorCode.NON_INTEGER_NUMBER);
  });

  it("rejects NaN and Infinity", () => {
    expectRejection(() => canonicalize({ n: Number.NaN }), ProtocolErrorCode.NON_FINITE_NUMBER);
    expectRejection(
      () => canonicalize({ n: Number.POSITIVE_INFINITY }),
      ProtocolErrorCode.NON_FINITE_NUMBER,
    );
  });

  it("rejects integers outside the safe range", () => {
    expectRejection(
      () => canonicalize({ n: 2 ** 53 }),
      ProtocolErrorCode.UNSAFE_INTEGER,
    );
  });

  it("rejects null by default and permits it when asked", () => {
    expectRejection(
      () => canonicalize({ a: null } as never),
      ProtocolErrorCode.UNEXPECTED_NULL,
    );
    expect(canonicalize({ a: null } as never, { allowNull: true })).toBe('{"a":null}');
  });

  it("omits undefined properties rather than emitting null", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
    // Absent and explicitly-undefined must be indistinguishable, or the same
    // logical value would produce two different hashes.
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it("rejects undefined array elements", () => {
    expectRejection(
      () => canonicalize([1, undefined, 2] as never),
      ProtocolErrorCode.UNSUPPORTED_TYPE,
    );
  });

  it("rejects functions and symbols", () => {
    expectRejection(
      () => canonicalize({ f: (() => 1) as never }),
      ProtocolErrorCode.UNSUPPORTED_TYPE,
    );
  });

  it("NFC-normalizes strings and keys", () => {
    const composed = "\u00e9"; // é
    const decomposed = "e\u0301"; // e + combining acute
    expect(canonicalize({ s: composed })).toBe(canonicalize({ s: decomposed }));
    expect(canonicalize({ [composed]: 1 })).toBe(canonicalize({ [decomposed]: 1 }));
  });

  it("rejects keys that collide after NFC normalization", () => {
    expectRejection(
      () => canonicalize({ "\u00e9": 1, "e\u0301": 2 }),
      ProtocolErrorCode.DUPLICATE_KEY,
    );
  });

  it("rejects lone surrogates", () => {
    expectRejection(
      () => canonicalize({ s: "\ud800" }),
      ProtocolErrorCode.LONE_SURROGATE,
    );
    expectRejection(
      () => canonicalize({ s: "\udc00" }),
      ProtocolErrorCode.LONE_SURROGATE,
    );
    // A valid surrogate pair must still be accepted.
    expect(canonicalize({ s: "\ud83d\ude00" })).toBe('{"s":"😀"}');
  });

  it("enforces the depth limit", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 70; i++) deep = { a: deep };
    expectRejection(
      () => canonicalize(deep as never),
      ProtocolErrorCode.DEPTH_EXCEEDED,
    );
  });

  it("enforces the size limit on encoded bytes, not code units", () => {
    // Two-byte characters: 600k of them exceed 1 MiB while being under it in
    // UTF-16 code units.
    const value = { s: "é".repeat(600_000) };
    expectRejection(() => canonicalize(value), ProtocolErrorCode.SIZE_EXCEEDED);
  });
});

describe("parseStrict", () => {
  it("parses ordinary JSON", () => {
    expect(parseStrict('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  it("rejects duplicate keys that JSON.parse would silently collapse", () => {
    expect(JSON.parse('{"a":1,"a":2}')).toEqual({ a: 2 });
    expectRejection(
      () => parseStrict('{"a":1,"a":2}'),
      ProtocolErrorCode.DUPLICATE_KEY,
    );
  });

  it("does not mistake string contents for structure", () => {
    expect(parseStrict('{"a":"{\\"a\\": 1}","b":2}')).toEqual({
      a: '{"a": 1}',
      b: 2,
    });
  });

  it("allows the same key in sibling objects", () => {
    expect(parseStrict('{"x":{"a":1},"y":{"a":2}}')).toEqual({
      x: { a: 1 },
      y: { a: 2 },
    });
  });

  it("allows repeated keys across array elements", () => {
    expect(parseStrict('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });
});
