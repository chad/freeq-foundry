import { NodeSubprocessSandbox } from "@freeq-foundry/sandbox";
import { describe, expect, it } from "vitest";
import {
  DeploymentLedger,
  defaultHealthProbes,
  deploy,
  survivedOperatingPeriod,
  type DeploymentRecord,
} from "./deployment.js";

const sandbox = new NodeSubprocessSandbox();
const COMMIT = `sha256:${"a".repeat(64)}` as `sha256:${string}`;

const working = new Map([
  ["src/index.mjs", "export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;"],
]);

const request = (files: Map<string, string>, overrides = {}) => ({
  deploymentId: "d-1",
  environment: "production" as const,
  commitHash: COMMIT,
  deployedByDid: "did:key:zAlice",
  capabilityGrantId: "g-1",
  atLogicalTime: 10,
  files,
  sandbox,
  ...overrides,
});

describe("deploying", () => {
  it("reports healthy when every probe passes", async () => {
    const record = await deploy(request(working));
    expect(record.status).toBe("healthy");
    expect(record.healthChecksPassed).toBe(record.healthChecksTotal);
    expect(record.healthChecksTotal).toBe(defaultHealthProbes().length);
  });

  it("reports unhealthy when the artifact does not load", async () => {
    // A product that passes its tests and then fails to start has not shipped, and
    // checking the source would not notice.
    const record = await deploy(request(new Map([["src/index.mjs", "this is not ("]])));
    expect(record.status).toBe("unhealthy");
    expect(record.detail).toContain("FAIL module-loads");
  });

  it("reports unhealthy when nothing is exported", async () => {
    const record = await deploy(request(new Map([["src/index.mjs", "const x = 1;"]])));
    expect(record.status).toBe("unhealthy");
    expect(record.detail).toContain("no exported functions");
  });

  it("runs probes in the sandbox, so a deployed artifact is still isolated", async () => {
    // §59.7: deployed code is still generated code.
    const record = await deploy(
      request(
        new Map([
          [
            "src/index.mjs",
            'import { readdir } from "node:fs/promises";' +
              "\nexport const leak = async () => readdir(process.cwd());",
          ],
        ]),
      ),
    );
    expect(record.status).toBe("healthy");
    // The probe saw only the deployed files, not the project.
    expect(record.detail).not.toContain("package.json");
  });

  it("refuses a tree that occupies the reserved probe path", async () => {
    const record = await deploy(
      request(new Map([...working, ["__probe__.mjs", 'console.log("hijacked");']])),
    );
    expect(record.status).toBe("unhealthy");
    expect(record.detail).toContain("reserved probe path");
  });

  it("records who deployed and under what authority", async () => {
    const record = await deploy(request(working));
    expect(record.deployedByDid).toBe("did:key:zAlice");
    expect(record.capabilityGrantId).toBe("g-1");
    expect(record.commitHash).toBe(COMMIT);
  });
});

describe("the ledger", () => {
  const record = (id: string, status: DeploymentRecord["status"] = "healthy"): DeploymentRecord => ({
    deploymentId: id,
    environment: "production",
    commitHash: COMMIT,
    deployedByDid: "did:key:zAlice",
    capabilityGrantId: "g-1",
    atLogicalTime: 10,
    status,
    healthChecksPassed: 2,
    healthChecksTotal: 2,
    detail: "",
  });

  it("keeps history rather than replacing", () => {
    // A rollback needs somewhere to roll back to, and §6.8 forbids erasing what
    // happened.
    const ledger = new DeploymentLedger();
    ledger.record(record("d-1"));
    ledger.record(record("d-2"));
    expect(ledger.history("production")).toHaveLength(2);
    expect(ledger.current("production")?.deploymentId).toBe("d-2");
  });

  it("marks the previous deployment superseded, not deleted", () => {
    const ledger = new DeploymentLedger();
    ledger.record(record("d-1"));
    ledger.record(record("d-2"));
    expect(ledger.history("production")[0]?.status).toBe("superseded");
  });

  it("rolls back to the previous deployment", () => {
    const ledger = new DeploymentLedger();
    ledger.record(record("d-1"));
    ledger.record(record("d-2", "unhealthy"));

    const outcome = ledger.rollback("production", { byDid: "did:key:zBob", atLogicalTime: 20 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.to.deploymentId).toBe("d-1");
    expect(ledger.current("production")?.status).toBe("healthy");
  });

  it("refuses a rollback with nothing to roll back to", () => {
    // An empty production environment is worse than an unhealthy one, because
    // nothing is serving.
    const ledger = new DeploymentLedger();
    ledger.record(record("d-1", "unhealthy"));
    const outcome = ledger.rollback("production", { byDid: "did:key:zBob", atLogicalTime: 20 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("worse than an unhealthy one");
  });

  it("keeps environments separate", () => {
    const ledger = new DeploymentLedger();
    ledger.record({ ...record("p-1"), environment: "preview" });
    expect(ledger.current("production")).toBeUndefined();
    expect(ledger.current("preview")?.deploymentId).toBe("p-1");
  });
});

describe("operating period", () => {
  const healthy: DeploymentRecord = {
    deploymentId: "d-1",
    environment: "production",
    commitHash: COMMIT,
    deployedByDid: "did:key:zAlice",
    capabilityGrantId: "g-1",
    atLogicalTime: 10,
    status: "healthy",
    healthChecksPassed: 2,
    healthChecksTotal: 2,
    detail: "",
  };

  it("is not satisfied the instant a deployment lands", () => {
    // §9.4. A release verified the moment it deployed has not been observed running.
    const result = survivedOperatingPeriod(healthy, 10, 3);
    expect(result.survived).toBe(false);
    expect(result.reason).toContain("0 tick(s) ago");
  });

  it("is satisfied once enough logical time has passed", () => {
    expect(survivedOperatingPeriod(healthy, 13, 3).survived).toBe(true);
  });

  it("is measured in logical time, so it is replayable", () => {
    // Wall-clock scheduling would make the same run reach a different verdict.
    expect(survivedOperatingPeriod(healthy, 20, 3)).toEqual(
      survivedOperatingPeriod(healthy, 20, 3),
    );
  });

  it("is not satisfied by an unhealthy deployment", () => {
    const result = survivedOperatingPeriod({ ...healthy, status: "unhealthy" }, 100, 3);
    expect(result.survived).toBe(false);
    expect(result.reason).toContain("unhealthy");
  });

  it("is not satisfied when nothing is deployed", () => {
    const result = survivedOperatingPeriod(undefined, 100, 3);
    expect(result.survived).toBe(false);
    expect(result.reason).toContain("nothing is deployed");
  });
});
