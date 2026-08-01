import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, NodeSubprocessSandbox, scanForSecrets } from "./sandbox.js";

const sandbox = new NodeSubprocessSandbox();
const files = (entries: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(entries));

describe("isolation is described honestly", () => {
  it("states what it does not provide", () => {
    // A sandbox believed to be stronger than it is, is worse than no sandbox.
    expect(sandbox.isolation).toContain("NOT sufficient for untrusted external code");
    expect(sandbox.isolation).toContain("process-level");
  });
});

describe("execution", () => {
  it("runs a successful program", async () => {
    const result = await sandbox.run({
      files: files({ "main.mjs": 'console.log("hello");' }),
      entryPoint: "main.mjs",
    });
    expect(result.outcome).toBe("succeeded");
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("reports a non-zero exit as failure", async () => {
    const result = await sandbox.run({
      files: files({ "main.mjs": "process.exit(3);" }),
      entryPoint: "main.mjs",
    });
    expect(result.outcome).toBe("failed");
    expect(result.exitCode).toBe(3);
  });

  it("captures stderr from a throwing program", async () => {
    const result = await sandbox.run({
      files: files({ "main.mjs": 'throw new Error("boom");' }),
      entryPoint: "main.mjs",
    });
    expect(result.outcome).toBe("failed");
    expect(result.stderr).toContain("boom");
  });

  it("supports imports between supplied files", async () => {
    const result = await sandbox.run({
      files: files({
        "lib.mjs": "export const value = 42;",
        "main.mjs": 'import { value } from "./lib.mjs"; console.log(value);',
      }),
      entryPoint: "main.mjs",
    });
    expect(result.stdout.trim()).toBe("42");
  });

  it("kills a program that will not stop", async () => {
    // A run that will not stop must be stopped.
    const result = await sandbox.run({
      files: files({ "main.mjs": "while (true) {}" }),
      entryPoint: "main.mjs",
      limits: { ...DEFAULT_LIMITS, timeoutMs: 500 },
    });
    expect(result.outcome).toBe("timed_out");
    expect(result.durationMs).toBeGreaterThanOrEqual(400);
  });

  it("kills a program that floods output", async () => {
    const result = await sandbox.run({
      files: files({ "main.mjs": 'while (true) { console.log("x".repeat(1000)); }' }),
      entryPoint: "main.mjs",
      limits: { ...DEFAULT_LIMITS, maxOutputBytes: 4096, timeoutMs: 5000 },
    });
    expect(result.outcome).toBe("output_limit_exceeded");
  });
});

describe("environment scrubbing", () => {
  it("does not leak the operator's environment", async () => {
    // Every real secret leak in a system like this starts with an inherited
    // environment (§6.10).
    process.env["FREEQ_TEST_SECRET"] = "should-not-be-visible";
    const result = await sandbox.run({
      files: files({
        "main.mjs": "console.log(JSON.stringify(Object.keys(process.env).sort()));",
      }),
      entryPoint: "main.mjs",
    });
    delete process.env["FREEQ_TEST_SECRET"];

    expect(result.outcome).toBe("succeeded");
    expect(result.stdout).not.toContain("FREEQ_TEST_SECRET");
    expect(result.stdout).not.toContain("should-not-be-visible");
  });

  it("signals that code is sandboxed", async () => {
    const result = await sandbox.run({
      files: files({ "main.mjs": "console.log(process.env.FREEQ_SANDBOX);" }),
      entryPoint: "main.mjs",
    });
    expect(result.stdout.trim()).toBe("1");
  });

  it("withholds PATH unless explicitly asked", async () => {
    const strict = await sandbox.run({
      files: files({ "main.mjs": "console.log(process.env.PATH ?? \"unset\");" }),
      entryPoint: "main.mjs",
    });
    expect(strict.stdout.trim()).toBe("unset");
  });
});

describe("filesystem containment", () => {
  it("runs in a directory outside the repository", async () => {
    const result = await sandbox.run({
      files: files({ "main.mjs": "console.log(process.cwd());" }),
      entryPoint: "main.mjs",
    });
    expect(result.stdout).not.toContain("freeq-foundry/packages");
    expect(result.stdout).toContain("freeq-sandbox-");
  });

  it("cannot see the project's files", async () => {
    const result = await sandbox.run({
      files: files({
        "main.mjs": [
          'import { readdir } from "node:fs/promises";',
          "const entries = await readdir(process.cwd());",
          "console.log(JSON.stringify(entries.sort()));",
        ].join("\n"),
      }),
      entryPoint: "main.mjs",
    });
    expect(result.stdout.trim()).toBe('["main.mjs"]');
  });

  it("tears down its directory afterwards", async () => {
    const result = await sandbox.run({
      files: files({ "main.mjs": "console.log(process.cwd());" }),
      entryPoint: "main.mjs",
    });
    const { existsSync } = await import("node:fs");
    expect(existsSync(result.stdout.trim())).toBe(false);
  });

  it("refuses a path that escapes the sandbox root", async () => {
    // Belt and braces: the repository already refuses these, but a sandbox that
    // trusts its input is not a sandbox.
    const result = await sandbox.run({
      files: files({ "../escape.mjs": "console.log(1);", "main.mjs": "" }),
      entryPoint: "main.mjs",
    });
    expect(result.outcome).toBe("rejected");
    expect(result.rejection).toContain("escapes the sandbox root");
  });
});

describe("request validation", () => {
  it("refuses an empty request", async () => {
    const result = await sandbox.run({ files: new Map(), entryPoint: "main.mjs" });
    expect(result.outcome).toBe("rejected");
  });

  it("refuses a missing entry point", async () => {
    const result = await sandbox.run({
      files: files({ "other.mjs": "" }),
      entryPoint: "main.mjs",
    });
    expect(result.outcome).toBe("rejected");
    expect(result.rejection).toContain("not among the supplied files");
  });

  it("refuses an oversized file", async () => {
    const result = await sandbox.run({
      files: files({ "main.mjs": "x".repeat(2000) }),
      entryPoint: "main.mjs",
      limits: { ...DEFAULT_LIMITS, maxFileBytes: 1000 },
    });
    expect(result.outcome).toBe("rejected");
  });

  it("refuses too many files", async () => {
    const many: Record<string, string> = { "main.mjs": "" };
    for (let i = 0; i < 20; i++) many[`f${i}.mjs`] = "";
    const result = await sandbox.run({
      files: files(many),
      entryPoint: "main.mjs",
      limits: { ...DEFAULT_LIMITS, maxFiles: 5 },
    });
    expect(result.outcome).toBe("rejected");
  });
});

describe("secret scanning", () => {
  it("finds common credential shapes", () => {
    const findings = scanForSecrets(
      files({
        "key.pem": "-----BEGIN RSA PRIVATE KEY-----\nabc",
        "aws.mjs": 'const id = "AKIAIOSFODNN7EXAMPLE";',
        "gh.mjs": 'const t = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456";',
        "cfg.mjs": 'const config = { api_key: "sk-not-a-real-key-1234" };',
      }),
    );
    const paths = findings.map((f) => f.path);
    expect(paths).toContain("key.pem");
    expect(paths).toContain("aws.mjs");
    expect(paths).toContain("gh.mjs");
    expect(paths).toContain("cfg.mjs");
  });

  it("does not flag ordinary code", () => {
    expect(
      scanForSecrets(files({ "a.mjs": "export const add = (a, b) => a + b;" })),
    ).toEqual([]);
  });

  it("is deliberately noisy rather than silent", () => {
    // A false positive costs a developer a minute; a false negative costs a
    // credential.
    const findings = scanForSecrets(files({ "a.mjs": 'const password = "hunter2hunter2";' }));
    expect(findings.length).toBeGreaterThan(0);
  });
});

describe("secret scanning: patterns that leak a key without storing one", () => {
  it("flags a command that echoes a credential environment variable", () => {
    // The mistake I made: printing a value to check whether it was set. Presence can
    // always be checked without disclosing the secret.
    for (const line of [
      'echo "ANTHROPIC_API_KEY set: ${ANTHROPIC_API_KEY:-no}"',
      "console.log(process.env.OPENAI_API_KEY)",
      'printf "%s" $GITHUB_TOKEN',
    ]) {
      expect(scanForSecrets(files({ "check.sh": line })).length, line).toBeGreaterThan(0);
    }
  });

  it("does not flag a presence check that discloses nothing", () => {
    const safe = 'echo "key set: ${ANTHROPIC_API_KEY:+yes}"';
    expect(scanForSecrets(files({ "check.sh": safe }))).toEqual([]);
  });

  it("flags provider key shapes directly", () => {
    const findings = scanForSecrets(
      files({
        "a.mjs": 'const k = "sk-ant-api03-' + "x".repeat(40) + '";',
        "b.mjs": 'const k = "sk-proj-' + "y".repeat(40) + '";',
      }),
    );
    expect(findings.map((f) => f.path).sort()).toEqual(["a.mjs", "b.mjs"]);
  });
});
