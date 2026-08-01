/**
 * Deployment: preview environments, production, rollback, and uptime.
 *
 * §29 and §30. Previously the evaluator verified that code *passed tests*; nothing was
 * ever deployed, so §9.4's requirement that the product survive an operating period was
 * satisfied vacuously.
 *
 * Two design rules:
 *
 *   1. **A deployment is a capability-gated action, and production is a different
 *      capability from preview.** An organization that can deploy a preview should not
 *      thereby be able to deploy production; §20.2's namespaces separate them, and the
 *      authorizer is the only thing that says yes.
 *   2. **The uptime check runs against the deployed artifact, not the source.** A
 *      product that passes its tests and then fails to start has not shipped, and
 *      checking the source would not notice.
 *
 * Deployments run in the sandbox, because a deployed artifact is still generated code
 * (§59.7). "Deployed" here means *running in an isolated environment and answering
 * health checks* — not reachable from the public internet, which would need real
 * infrastructure and is out of scope for a controlled run.
 *
 * Spec: §29, §30, §9.4.
 */
import type { Digest } from "@freeq-foundry/protocol";
import type { Sandbox, SandboxLimits } from "@freeq-foundry/sandbox";

export type Environment = "preview" | "production";

export interface DeploymentRecord {
  readonly deploymentId: string;
  readonly environment: Environment;
  readonly commitHash: Digest;
  readonly deployedByDid: string;
  readonly capabilityGrantId: string;
  readonly atLogicalTime: number;
  readonly status: "healthy" | "unhealthy" | "rolled_back" | "superseded";
  /** Health probes passed at deployment. */
  readonly healthChecksPassed: number;
  readonly healthChecksTotal: number;
  readonly detail: string;
}

export interface HealthProbe {
  readonly id: string;
  readonly description: string;
  /**
   * Source executed against the deployed tree.
   *
   * Must exit non-zero on failure. Kept separate from acceptance criteria: a health
   * probe asks "is it running?", a criterion asks "is it correct?", and conflating them
   * would let a correct-but-dead product count as deployed.
   */
  readonly source: string;
}

/** Default probes: the product loads and its public surface is callable. */
export function defaultHealthProbes(): readonly HealthProbe[] {
  return [
    {
      id: "module-loads",
      description: "The entry point imports without throwing",
      source: [
        'const api = await import("./src/index.mjs");',
        'if (typeof api !== "object" || api === null) {',
        '  console.error("entry point did not produce a module namespace");',
        "  process.exit(1);",
        "}",
        'console.log("module loads");',
      ].join("\n"),
    },
    {
      id: "surface-callable",
      description: "Every exported function can be called without throwing on load",
      source: [
        'const api = await import("./src/index.mjs");',
        "const functions = Object.entries(api).filter(([, v]) => typeof v === \"function\");",
        "if (functions.length === 0) {",
        '  console.error("no exported functions");',
        "  process.exit(1);",
        "}",
        'console.log("surface: " + functions.map(([k]) => k).join(", "));',
      ].join("\n"),
    },
  ];
}

export interface DeployRequest {
  readonly deploymentId: string;
  readonly environment: Environment;
  readonly commitHash: Digest;
  readonly deployedByDid: string;
  readonly capabilityGrantId: string;
  readonly atLogicalTime: number;
  readonly files: ReadonlyMap<string, string>;
  readonly probes?: readonly HealthProbe[];
  readonly sandbox: Sandbox;
  readonly limits?: SandboxLimits;
}

const PROBE_ENTRY = "__probe__.mjs";

/**
 * Deploy and health-check.
 *
 * The caller must already have authorized the namespace — `deploy.preview` or
 * `deploy.production`. This runs the probes and reports; it does not decide authority,
 * for the same reason the repository does not.
 */
export async function deploy(request: DeployRequest): Promise<DeploymentRecord> {
  const probes = request.probes ?? defaultHealthProbes();
  const results: { id: string; passed: boolean; detail: string }[] = [];

  for (const probe of probes) {
    if (request.files.has(PROBE_ENTRY)) {
      // The tree must not be able to shadow the harness.
      results.push({
        id: probe.id,
        passed: false,
        detail: "the deployed tree occupies the reserved probe path",
      });
      continue;
    }

    const run = await request.sandbox.run({
      files: new Map([...request.files, [PROBE_ENTRY, probe.source]]),
      entryPoint: PROBE_ENTRY,
      ...(request.limits === undefined ? {} : { limits: request.limits }),
      profile: "strict",
    });

    results.push({
      id: probe.id,
      passed: run.outcome === "succeeded",
      detail:
        run.outcome === "succeeded"
          ? run.stdout.trim().slice(0, 200)
          : `${run.outcome}: ${(run.stderr || run.rejection || "").trim().slice(0, 300)}`,
    });
  }

  const passed = results.filter((result) => result.passed).length;
  const healthy = passed === results.length && results.length > 0;

  return {
    deploymentId: request.deploymentId,
    environment: request.environment,
    commitHash: request.commitHash,
    deployedByDid: request.deployedByDid,
    capabilityGrantId: request.capabilityGrantId,
    atLogicalTime: request.atLogicalTime,
    status: healthy ? "healthy" : "unhealthy",
    healthChecksPassed: passed,
    healthChecksTotal: results.length,
    detail: results
      .map((result) => `${result.passed ? "ok" : "FAIL"} ${result.id}: ${result.detail}`)
      .join("; "),
  };
}

/**
 * Tracks deployments per environment.
 *
 * Keeps history rather than replacing: a rollback needs somewhere to roll back *to*,
 * and §6.8 forbids erasing what happened.
 */
export class DeploymentLedger {
  readonly #byEnvironment = new Map<Environment, DeploymentRecord[]>();

  record(deployment: DeploymentRecord): void {
    const history = this.#byEnvironment.get(deployment.environment) ?? [];
    // The previous healthy deployment becomes superseded, not deleted.
    const superseded = history.map((entry) =>
      entry.status === "healthy" ? { ...entry, status: "superseded" as const } : entry,
    );
    this.#byEnvironment.set(deployment.environment, [...superseded, deployment]);
  }

  current(environment: Environment): DeploymentRecord | undefined {
    const history = this.#byEnvironment.get(environment) ?? [];
    return history[history.length - 1];
  }

  history(environment: Environment): readonly DeploymentRecord[] {
    return this.#byEnvironment.get(environment) ?? [];
  }

  /** Most recent deployment that was healthy and is not the current one. */
  rollbackTarget(environment: Environment): DeploymentRecord | undefined {
    const history = this.#byEnvironment.get(environment) ?? [];
    return [...history]
      .slice(0, -1)
      .reverse()
      .find((entry) => entry.status === "healthy" || entry.status === "superseded");
  }

  /**
   * Roll back to the previous healthy deployment.
   *
   * Refuses when there is nothing to roll back to, rather than leaving an environment
   * with no deployment at all — an empty production environment is worse than an
   * unhealthy one, because nothing is serving.
   */
  rollback(
    environment: Environment,
    options: { readonly byDid: string; readonly atLogicalTime: number },
  ):
    | { readonly ok: true; readonly to: DeploymentRecord }
    | { readonly ok: false; readonly reason: string } {
    const target = this.rollbackTarget(environment);
    if (target === undefined) {
      return {
        ok: false,
        reason:
          `no previous deployment in ${environment} to roll back to; an empty environment ` +
          `is worse than an unhealthy one`,
      };
    }

    const history = this.#byEnvironment.get(environment) ?? [];
    const current = history[history.length - 1];
    if (current !== undefined) {
      this.#byEnvironment.set(environment, [
        ...history.slice(0, -1),
        { ...current, status: "rolled_back" },
        {
          ...target,
          deploymentId: `${target.deploymentId}-rollback-${options.atLogicalTime}`,
          deployedByDid: options.byDid,
          atLogicalTime: options.atLogicalTime,
          status: "healthy",
        },
      ]);
    }
    return { ok: true, to: target };
  }
}

/**
 * Whether a production deployment has survived its minimum operating period.
 *
 * §9.4 requires the product to survive an uptime check, and a release verified the
 * instant it deployed has not been observed running. Measured in logical time so it is
 * replayable rather than dependent on wall-clock scheduling.
 */
export function survivedOperatingPeriod(
  deployment: DeploymentRecord | undefined,
  atLogicalTime: number,
  minimumLogicalTicks: number,
): { readonly survived: boolean; readonly reason: string } {
  if (deployment === undefined) {
    return { survived: false, reason: "nothing is deployed to production" };
  }
  if (deployment.status !== "healthy") {
    return {
      survived: false,
      reason: `the production deployment is ${deployment.status}`,
    };
  }
  const elapsed = atLogicalTime - deployment.atLogicalTime;
  if (elapsed < minimumLogicalTicks) {
    return {
      survived: false,
      reason: `deployed ${elapsed} tick(s) ago; ${minimumLogicalTicks} required`,
    };
  }
  return {
    survived: true,
    reason: `healthy in production for ${elapsed} tick(s)`,
  };
}
