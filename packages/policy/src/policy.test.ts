import { describe, expect, it } from "vitest";
import {
  POLICY_LANGUAGE,
  PolicyParseError,
  formatPolicy,
  parsePolicy,
} from "./parse.js";
import {
  attributesOf,
  evaluatePolicy,
  globMatches,
  globNarrows,
  narrows,
  validateAttributes,
} from "./evaluate.js";

describe("parsing", () => {
  it("parses a single comparison", () => {
    expect(parsePolicy('repo.path glob "src/**"')).toEqual({
      comparisons: [
        { attribute: "repo.path", operator: "glob", value: "src/**" },
      ],
    });
  });

  it("parses a conjunction", () => {
    const parsed = parsePolicy('a = "x" and b >= 3 and c in ["p", "q"]');
    expect(parsed.comparisons).toHaveLength(3);
    expect(parsed.comparisons[2]).toEqual({
      attribute: "c",
      operator: "in",
      value: ["p", "q"],
    });
  });

  it("round-trips through formatting", () => {
    const source = 'repo.path glob "packages/api/**" and repo.branch glob "feature/*"';
    expect(formatPolicy(parsePolicy(source))).toBe(source);
  });

  it("handles negative integers", () => {
    expect(parsePolicy("balance >= -100").comparisons[0]?.value).toBe(-100);
  });

  it("handles escaped quotes in strings", () => {
    expect(parsePolicy('name = "say \\"hi\\""').comparisons[0]?.value).toBe('say "hi"');
  });

  it("rejects an empty expression rather than guessing what it means", () => {
    // "Always true" and "always false" are both plausible readings, and guessing
    // wrong in either direction is a security bug.
    expect(() => parsePolicy("")).toThrow(PolicyParseError);
    expect(() => parsePolicy("   ")).toThrow(PolicyParseError);
  });

  it("rejects disjunction, and explains why", () => {
    // The omission is the design, so the error says so rather than reporting an
    // unknown identifier.
    expect(() => parsePolicy('a = "x" or b = "y"')).toThrow(/undecidable/);
  });

  it("rejects negation", () => {
    expect(() => parsePolicy('not a = "x"')).toThrow(/undecidable/);
  });

  it("rejects non-integer numbers", () => {
    expect(() => parsePolicy("ratio <= 0.5")).toThrow(/non-integer/);
  });

  it("rejects a missing operator", () => {
    expect(() => parsePolicy("attribute")).toThrow(/expected an operator/);
  });

  it("rejects a missing conjunction between comparisons", () => {
    expect(() => parsePolicy('a = "x" b = "y"')).toThrow(/expected 'and'/);
  });

  it("rejects an unterminated string", () => {
    expect(() => parsePolicy('a = "unterminated')).toThrow(/unterminated string/);
  });

  it("rejects an unterminated list", () => {
    expect(() => parsePolicy('a in ["x", "y"')).toThrow(/expected ',' or ']'/);
    expect(() => parsePolicy('a in ["x"')).toThrow(/expected ',' or ']'/);
  });

  it("rejects attribute-to-attribute comparison, and explains the design", () => {
    // Agents will reach for this. Supporting it would mean comparing two
    // attribute-relative constraints during narrowing, which is the reasoning
    // ADR-0010 excludes. Derived quantities are the harness's job.
    expect(() => parsePolicy("a.yes_count > a.no_count")).toThrow(
      /attribute-to-attribute comparison is not supported/,
    );
  });

  it("rejects 'in' without a list", () => {
    expect(() => parsePolicy('a in "x"')).toThrow(/requires a list/);
  });

  it("rejects a list with a comparison operator that is not 'in'", () => {
    expect(() => parsePolicy('a = ["x"]')).toThrow(/does not accept a list/);
  });

  it("rejects 'glob' with a non-string pattern", () => {
    expect(() => parsePolicy("a glob 3")).toThrow(/requires a string pattern/);
  });

  it("reports a position for every error", () => {
    try {
      parsePolicy('a = "x" and');
      throw new Error("expected a parse error");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyParseError);
      expect((error as PolicyParseError).message).toMatch(/at position \d+/);
    }
  });
});

describe("evaluation", () => {
  it("allows when every condition holds", () => {
    const decision = evaluatePolicy('role = "release_manager" and tenure >= 2', {
      role: "release_manager",
      tenure: 3,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.engine).toBe(POLICY_LANGUAGE);
    expect(decision.engineVersion).toBe(1);
  });

  it("denies with an explicable reason", () => {
    // §20.4: a denial must be explicable, not merely returned.
    const decision = evaluatePolicy("tenure >= 5", { tenure: 2 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("tenure is 2");
    expect(decision.failedComparison).toBe("tenure >= 5");
  });

  it("denies on an unknown attribute rather than evaluating false", () => {
    // A typo must not become a quietly permissive rule. Denying makes the
    // mistake visible; returning false would hide it.
    const decision = evaluatePolicy("tenrue >= 5", { tenure: 10 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("not in the evaluation context");
  });

  it("denies on an unparseable expression instead of throwing", () => {
    const decision = evaluatePolicy('a = "x" or b = "y"', { a: "x" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("does not parse");
  });

  it("denies on a type mismatch", () => {
    const decision = evaluatePolicy("name >= 5", { name: "alice" });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("cannot apply");
  });

  it("never throws, whatever the input", () => {
    for (const source of ["", "!!!", "a", 'a = ', "a in b", "((("]) {
      expect(() => evaluatePolicy(source, {})).not.toThrow();
      expect(evaluatePolicy(source, {}).allowed).toBe(false);
    }
  });

  it("supports every operator", () => {
    const context = { s: "abc", n: 5 };
    const cases: Array<[string, boolean]> = [
      ['s = "abc"', true],
      ['s != "xyz"', true],
      ["n < 6", true],
      ["n <= 5", true],
      ["n > 4", true],
      ["n >= 5", true],
      ['s glob "a*"', true],
      ['s in ["abc", "def"]', true],
      ['s = "xyz"', false],
      ["n > 5", false],
      ['s in ["def"]', false],
    ];
    for (const [source, expected] of cases) {
      expect(evaluatePolicy(source, context).allowed, source).toBe(expected);
    }
  });

  it("is deterministic, which replay requires", () => {
    const context = { a: "x", n: 1 };
    const first = evaluatePolicy('a = "x" and n >= 1', context);
    const second = evaluatePolicy('a = "x" and n >= 1', context);
    expect(first).toEqual(second);
  });
});

describe("glob", () => {
  it("matches within a segment", () => {
    expect(globMatches("src/*.ts", "src/index.ts")).toBe(true);
    expect(globMatches("src/*.ts", "src/nested/index.ts")).toBe(false);
  });

  it("matches across segments with **", () => {
    expect(globMatches("src/**", "src/a/b/c.ts")).toBe(true);
    expect(globMatches("packages/api/**", "packages/api/src/x.ts")).toBe(true);
    expect(globMatches("packages/api/**", "packages/web/src/x.ts")).toBe(false);
  });

  it("matches a single character with ?", () => {
    expect(globMatches("a?c", "abc")).toBe(true);
    expect(globMatches("a?c", "ac")).toBe(false);
  });

  it("treats regex metacharacters literally", () => {
    expect(globMatches("a.b", "a.b")).toBe(true);
    expect(globMatches("a.b", "axb")).toBe(false);
  });

  it("lets a/**/b match a/b", () => {
    expect(globMatches("a/**/b", "a/b")).toBe(true);
    expect(globMatches("a/**/b", "a/x/y/b")).toBe(true);
  });
});

describe("narrowing (attenuation)", () => {
  it("accepts an added conjunct", () => {
    const result = narrows(
      'repo.path glob "src/**" and repo.branch glob "feature/*"',
      'repo.path glob "src/**"',
    );
    expect(result.narrows).toBe(true);
  });

  it("rejects a dropped conjunct", () => {
    // Dropping a parent constraint widens authority.
    const result = narrows(
      'repo.path glob "src/**"',
      'repo.path glob "src/**" and repo.branch glob "feature/*"',
    );
    expect(result.narrows).toBe(false);
    expect(result.reason).toContain("does not constrain repo.branch");
  });

  it("narrows a numeric upper bound", () => {
    expect(narrows("amount <= 50", "amount <= 100").narrows).toBe(true);
    expect(narrows("amount <= 200", "amount <= 100").narrows).toBe(false);
  });

  it("narrows a numeric lower bound in the other direction", () => {
    expect(narrows("tenure >= 5", "tenure >= 2").narrows).toBe(true);
    expect(narrows("tenure >= 1", "tenure >= 2").narrows).toBe(false);
  });

  it("narrows a set membership to a subset", () => {
    expect(narrows('env in ["dev"]', 'env in ["dev", "staging"]').narrows).toBe(true);
    expect(narrows('env in ["dev", "prod"]', 'env in ["dev"]').narrows).toBe(false);
  });

  it("treats equality as the narrowest form", () => {
    expect(narrows('env = "dev"', 'env in ["dev", "staging"]').narrows).toBe(true);
    expect(narrows('env = "prod"', 'env in ["dev", "staging"]').narrows).toBe(false);
    expect(narrows("amount = 10", "amount <= 100").narrows).toBe(true);
    expect(narrows("amount = 500", "amount <= 100").narrows).toBe(false);
  });

  it("narrows a glob to a more specific glob", () => {
    expect(globNarrows("packages/api/**", "packages/**")).toBe(true);
    expect(globNarrows("packages/**", "packages/api/**")).toBe(false);
    expect(globNarrows("src/index.ts", "src/*")).toBe(true);
    expect(globNarrows("src/*", "src/index.ts")).toBe(false);
  });

  it("treats an unconstrained parent as narrowable by anything", () => {
    expect(narrows('a = "x"', 'a glob "*"').narrows).toBe(true);
  });

  it("refuses when containment cannot be established", () => {
    // Conservative by design: refusing a legitimate narrowing is an
    // inconvenience, permitting an illegitimate one is a privilege escalation.
    expect(globNarrows("a/**/b", "a/**/c")).toBe(false);
    expect(narrows("amount < 50", "amount <= 100").narrows).toBe(false);
  });

  it("refuses to compare unparseable expressions", () => {
    const result = narrows('a = "x" or b = "y"', 'a = "x"');
    expect(result.narrows).toBe(false);
    expect(result.reason).toContain("unparseable");
  });

  it("is reflexive", () => {
    const source = 'repo.path glob "src/**" and amount <= 100';
    expect(narrows(source, source).narrows).toBe(true);
  });

  it("is not symmetric, since narrowing is directional", () => {
    const child = 'a glob "x/y/**"';
    const parent = 'a glob "x/**"';
    expect(narrows(child, parent).narrows).toBe(true);
    expect(narrows(parent, child).narrows).toBe(false);
  });
});

describe("attribute vocabulary", () => {
  it("lists the attributes an expression reads", () => {
    expect(attributesOf('a = "x" and b.c >= 1 and a != "y"')).toEqual(["a", "b.c"]);
  });

  it("returns nothing for an unparseable expression", () => {
    expect(attributesOf("!!!")).toEqual([]);
  });

  it("reports attributes outside the permitted vocabulary", () => {
    // Rejecting at proposal time gives a clear error, instead of a rule that
    // parses and then denies everything forever.
    expect(validateAttributes('a = "x" and z = "y"', ["a", "b"])).toEqual(["z"]);
    expect(validateAttributes('a = "x"', ["a", "b"])).toEqual([]);
  });
});

describe("the five rules from the ADR-0007 exercise", () => {
  it("1. quorum requiring distinct terminal human roots", () => {
    // Note `proposal.yes_share_pct`, a harness-computed attribute. Writing this
    // as `yes_count > no_count` would be attribute-to-attribute comparison, which
    // the language excludes — derived quantities are computed and offered, not
    // expressed.
    const rule =
      "proposal.distinct_lineages >= 3 and proposal.yes_share_pct > 50";
    expect(
      evaluatePolicy(rule, {
        "proposal.distinct_lineages": 3,
        "proposal.yes_share_pct": 83,
      }).allowed,
    ).toBe(true);
    expect(
      evaluatePolicy(rule, {
        "proposal.distinct_lineages": 2,
        "proposal.yes_share_pct": 100,
      }).allowed,
    ).toBe(false);
  });

  it("2. election method is data, not an expression", () => {
    // The exercise's first finding: aggregation does not belong in the language.
    // An agent inventing a voting method inside an expression is a bug surface.
    expect(() => parsePolicy("argmax(candidates, approvals)")).toThrow();
  });

  it("3. capability scoped to a path and branch pattern", () => {
    const grant = 'repo.path glob "packages/api/**" and repo.branch glob "feature/*"';
    expect(
      evaluatePolicy(grant, {
        "repo.path": "packages/api/src/handler.ts",
        "repo.branch": "feature/auth",
      }).allowed,
    ).toBe(true);
    expect(
      evaluatePolicy(grant, {
        "repo.path": "packages/api/src/handler.ts",
        "repo.branch": "main",
      }).allowed,
    ).toBe(false);
  });

  it("4. attenuation is mechanically checkable — the discriminator", () => {
    const parent = 'repo.path glob "packages/api/**" and repo.branch glob "feature/*"';
    const narrower =
      'repo.path glob "packages/api/src/**" and repo.branch glob "feature/*"';
    const wider = 'repo.path glob "packages/**" and repo.branch glob "feature/*"';

    expect(narrows(narrower, parent).narrows).toBe(true);
    expect(narrows(wider, parent).narrows).toBe(false);
  });

  it("5. sunset is structural, not expressed", () => {
    // Kept as a field on the rule, so a projection computes active rules without
    // evaluating anything. Expressible here too, but that is not where it lives.
    expect(evaluatePolicy("run.logical_time < 5000", { "run.logical_time": 4999 }).allowed).toBe(
      true,
    );
    expect(evaluatePolicy("run.logical_time < 5000", { "run.logical_time": 5000 }).allowed).toBe(
      false,
    );
  });
});
