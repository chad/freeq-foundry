/**
 * Post-run report generation.
 *
 * §59.16: "Make reports evidence-backed. Every important interpretation should
 * link to source events." A generated narrative that cannot be traced to events is
 * an unfalsifiable claim, which is worse than no report — so every turning point
 * here carries the event IDs it was derived from.
 *
 * §59.17: "Prefer a legible failure to an opaque success." A run that failed
 * should produce a report explaining why, not a shorter one.
 *
 * Spec: §37.6, §41.
 */
import { RunValidity, type RecordedEvent } from "@freeq-foundry/protocol";
import { EventTypes, categoryOf } from "@freeq-foundry/projections";
import { computeMetrics, productiveTimeScore, autonomyFlags, type RunSnapshot } from "./metrics.js";

/** A moment the run's trajectory changed (§37.6). */
export interface TurningPoint {
  readonly logicalTime: number;
  readonly kind:
    | "constitution_adopted"
    | "first_authority_granted"
    | "proposal_failed"
    | "authority_revoked"
    | "action_denied"
    | "release_rejected"
    | "release_verified"
    | "participant_suspended"
    | "budget_exhausted"
    | "safety_event";
  readonly summary: string;
  /** Events this was derived from. The evidence link (§59.16). */
  readonly evidenceEventIds: readonly string[];
}

/**
 * Classify turning points from the log.
 *
 * Deliberately mechanical. A classifier that inferred motive would be producing
 * interpretation and presenting it as observation, which §40.1 forbids.
 */
export function detectTurningPoints(
  events: readonly RecordedEvent[],
): readonly TurningPoint[] {
  const points: TurningPoint[] = [];
  let firstGrantSeen = false;
  let firstDenialSeen = false;

  for (const event of events) {
    const evidence = [event.eventId];

    switch (event.eventType) {
      case EventTypes.CONSTITUTION_ADOPTED: {
        const payload = event.payload as { version: number };
        points.push({
          logicalTime: event.logicalTime,
          kind: "constitution_adopted",
          summary:
            payload.version === 1
              ? "Genesis constitution adopted."
              : `Constitution amended to version ${payload.version}.`,
          evidenceEventIds: evidence,
        });
        break;
      }

      case EventTypes.CAPABILITY_GRANTED: {
        if (firstGrantSeen) break;
        firstGrantSeen = true;
        const payload = event.payload as { toDid: string; namespace: string };
        points.push({
          logicalTime: event.logicalTime,
          kind: "first_authority_granted",
          summary: `First authority granted: ${payload.namespace} to ${short(payload.toDid)}. The organization became able to act.`,
          evidenceEventIds: evidence,
        });
        break;
      }

      case EventTypes.CAPABILITY_REVOKED:
        points.push({
          logicalTime: event.logicalTime,
          kind: "authority_revoked",
          summary: `Authority revoked: grant ${(event.payload as { grantId: string }).grantId}.`,
          evidenceEventIds: evidence,
        });
        break;

      case EventTypes.PROPOSAL_CLOSED: {
        const payload = event.payload as { outcome: string; proposalId: string; reason: string };
        if (payload.outcome !== "failed") break;
        points.push({
          logicalTime: event.logicalTime,
          kind: "proposal_failed",
          summary: `Proposal ${payload.proposalId} failed: ${payload.reason}`,
          evidenceEventIds: evidence,
        });
        break;
      }

      case EventTypes.ACTION_DENIED: {
        // Only the first is a turning point. A steady stream of denials is a
        // pattern, reported as a count rather than as many separate moments.
        if (firstDenialSeen) break;
        firstDenialSeen = true;
        const payload = event.payload as { actorDid: string; attemptedNamespace: string };
        points.push({
          logicalTime: event.logicalTime,
          kind: "action_denied",
          summary: `First refusal: ${short(payload.actorDid)} attempted ${payload.attemptedNamespace} without authority.`,
          evidenceEventIds: evidence,
        });
        break;
      }

      case EventTypes.PARTICIPANT_SUSPENDED: {
        const payload = event.payload as { did: string; reasonCode: string };
        points.push({
          logicalTime: event.logicalTime,
          kind: "participant_suspended",
          summary: `${short(payload.did)} suspended (${payload.reasonCode}).`,
          evidenceEventIds: evidence,
        });
        break;
      }

      case EventTypes.RELEASE_REJECTED: {
        const payload = event.payload as { releaseId: string; failures: readonly string[] };
        points.push({
          logicalTime: event.logicalTime,
          kind: "release_rejected",
          summary: `Release ${payload.releaseId} rejected by the evaluator; ${payload.failures.length} criterion(s) unmet.`,
          evidenceEventIds: evidence,
        });
        break;
      }

      case EventTypes.RELEASE_VERIFIED: {
        const payload = event.payload as { releaseId: string };
        points.push({
          logicalTime: event.logicalTime,
          kind: "release_verified",
          summary: `Release ${payload.releaseId} verified by the external evaluator. Objective met.`,
          evidenceEventIds: evidence,
        });
        break;
      }

      case EventTypes.BUDGET_EXHAUSTED:
        points.push({
          logicalTime: event.logicalTime,
          kind: "budget_exhausted",
          summary: "Budget exhausted.",
          evidenceEventIds: evidence,
        });
        break;

      case EventTypes.SAFETY_EVENT: {
        const payload = event.payload as { severity: string; description: string };
        if (payload.severity !== "severe" && payload.severity !== "terminal") break;
        points.push({
          logicalTime: event.logicalTime,
          kind: "safety_event",
          summary: `Safety event (${payload.severity}): ${payload.description}`,
          evidenceEventIds: evidence,
        });
        break;
      }

      default:
        break;
    }
  }

  return points;
}

export interface ReportInput {
  readonly runId: string;
  readonly snapshot: RunSnapshot;
  readonly events: readonly RecordedEvent[];
  readonly recorderDid: string;
  readonly arm?: string;
}

/**
 * Generate a Markdown report.
 *
 * Sections are ordered so a reader encounters the outcome, then the evidence for
 * it, then the caveats — rather than a narrative that arrives at a conclusion.
 */
export function generateReport(input: ReportInput): string {
  const { snapshot, events } = input;
  const metrics = computeMetrics(snapshot);
  const turningPoints = detectTurningPoints(events);
  const flags = autonomyFlags(snapshot);

  const primary = metrics.find((m) => m.tier === "primary");
  const score = productiveTimeScore(snapshot);
  const hours = (ms: number | undefined): string =>
    ms === undefined ? "—" : `${(ms / 3_600_000).toFixed(2)} h`;

  const lines: string[] = [];

  lines.push(`# Run report: ${input.runId}`);
  lines.push("");
  lines.push(
    `**Outcome:** ${snapshot.outcome.shipped ? "shipped" : "did not ship"} · ` +
      `**Termination:** ${snapshot.run.terminationReason ?? "unknown"} · ` +
      `**Validity:** ${snapshot.run.validity}`,
  );
  if (input.arm !== undefined) lines.push(`**Arm:** ${input.arm}`);
  lines.push(
    `**Confirmatory:** ${snapshot.run.confirmatory ? "yes" : "no — this run is a pilot, not evidence"}`,
  );
  lines.push("");

  if (snapshot.run.validity !== RunValidity.VALID) {
    lines.push(
      `> This run is **${snapshot.run.validity}** and must be replaced rather than ` +
        `scored. The primary outcome is not computed.`,
    );
    lines.push("");
  }

  // --- Primary outcome ---
  lines.push("## Primary outcome");
  lines.push("");
  lines.push(
    "Restricted mean time to evaluator-verified release, per the " +
      "[research protocol](../../docs/research-protocol.md). Lower is better.",
  );
  lines.push("");
  lines.push("| Measure | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Time to release | ${hours(snapshot.run.timeToReleaseMs)} |`);
  lines.push(`| Horizon | ${hours(snapshot.run.horizonMs)} |`);
  lines.push(`| Restricted time | ${hours(primary?.value)} |`);
  lines.push(`| Productive-time score | ${hours(score)} |`);
  lines.push("");

  // --- Turning points, with evidence ---
  lines.push("## Turning points");
  lines.push("");
  if (turningPoints.length === 0) {
    lines.push("Nothing of consequence happened. That is itself the finding.");
  } else {
    lines.push("| Logical time | Event | Evidence |");
    lines.push("| --: | --- | --- |");
    for (const point of turningPoints) {
      lines.push(
        `| ${point.logicalTime} | ${point.summary} | \`${point.evidenceEventIds.join("`, `")}\` |`,
      );
    }
  }
  lines.push("");

  // --- Confirmatory metrics ---
  lines.push("## Confirmatory metrics");
  lines.push("");
  lines.push(
    "Tested in the fixed gatekeeping order below. Once one fails, later findings " +
      "are descriptive rather than confirmatory.",
  );
  lines.push("");
  lines.push("| # | Metric | Value | Unit |");
  lines.push("| --: | --- | --: | --- |");
  for (const metric of metrics
    .filter((m) => m.tier === "secondary")
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))) {
    lines.push(
      `| ${metric.ordinal} | ${metric.id} | ${metric.value ?? "—"} | ${metric.unit} |`,
    );
  }
  lines.push("");

  // --- Exploratory ---
  lines.push("## Exploratory metrics");
  lines.push("");
  lines.push(
    "**Not evidence that a condition worked.** Reported with source events so a " +
      "reader can check them.",
  );
  lines.push("");
  lines.push("| Metric | Value | Unit |");
  lines.push("| --- | --: | --- |");
  for (const metric of metrics.filter((m) => m.tier === "exploratory")) {
    lines.push(`| ${metric.id} | ${metric.value ?? "—"} | ${metric.unit} |`);
  }
  lines.push("");

  // --- Organization ---
  lines.push("## Organization");
  lines.push("");
  lines.push("| Property | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Participants | ${snapshot.participants.byDid.size} |`);
  lines.push(`| Constitution version | ${snapshot.constitution.version} |`);
  lines.push(`| Rules in force | ${snapshot.constitution.rules.size} |`);
  lines.push(`| Proposals opened | ${snapshot.proposals.byId.size} |`);
  lines.push(`| Capability grants | ${snapshot.capabilities.grants.size} |`);
  lines.push(`| Actions denied | ${snapshot.capabilities.deniedActions} |`);
  lines.push(`| Events recorded | ${events.length} |`);
  lines.push("");

  // --- Activity ---
  lines.push("### Activity by category");
  lines.push("");
  lines.push("| Category | Events |");
  lines.push("| --- | --: |");
  for (const [category, count] of [...snapshot.activity.byCategory.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`| ${category} | ${count} |`);
  }
  lines.push("");

  // --- Caveats ---
  lines.push("## Caveats");
  lines.push("");
  const caveats: string[] = [];

  if (!snapshot.run.confirmatory) {
    caveats.push(
      "This run is **not** confirmatory. It may inform design and produce pilot " +
        "variance estimates, but it is not evidence that one institutional design " +
        "is better than another.",
    );
  }
  if (flags.length > 0) {
    caveats.push(
      `${flags.length} participant(s) declared themselves autonomous while a ` +
        `majority of their actions followed a signed instruction: ` +
        `${flags.map((f) => `${short(f.did)} (${Math.round(f.instructedShare * 100)}%)`).join(", ")}. ` +
        `Claims about model behaviour must account for this (§58.5).`,
    );
  }
  const modelEvents = events.filter((e) => categoryOf(e.eventType) === "model");
  if (modelEvents.length === 0) {
    caveats.push(
      "No model was invoked: every participant was deterministic. This validates " +
        "the harness but says nothing about model behaviour.",
    );
  }
  if (snapshot.outcome.releaseAttempts === 0) {
    caveats.push(
      "No release was ever attempted, so the acceptance fraction is undefined " +
        "rather than zero. Not attempting is a different fact from attempting and failing.",
    );
  }
  if (
    snapshot.run.validityJudgedAtLogicalTime !== undefined &&
    snapshot.run.firstEvaluationLogicalTime !== undefined &&
    snapshot.run.validityJudgedAtLogicalTime > snapshot.run.firstEvaluationLogicalTime
  ) {
    caveats.push(
      "**The validity judgement postdates the first evaluation event.** The " +
        "replacement decision was therefore not blind, and this run must not be " +
        "used in a confirmatory set (ADR-0009).",
    );
  }

  if (caveats.length === 0) {
    lines.push("None identified.");
  } else {
    for (const caveat of caveats) lines.push(`- ${caveat}`);
  }
  lines.push("");

  // --- Provenance ---
  lines.push("## Provenance");
  lines.push("");
  lines.push(`- Recorder: \`${input.recorderDid}\``);
  lines.push(`- Evaluator: \`${snapshot.run.evaluatorDid ?? "—"}\``);
  lines.push(`- Manifest hash: \`${snapshot.run.manifestHash ?? "—"}\``);
  lines.push(
    `- Every event in this run is signed twice: by its actor over content, and by ` +
      `the recorder over position ([ADR-0008](../../docs/adr/0008-event-authorship.md)).`,
  );
  lines.push("");

  return lines.join("\n");
}

function short(did: string): string {
  return did.length > 16 ? `${did.slice(0, 12)}…${did.slice(-4)}` : did;
}
