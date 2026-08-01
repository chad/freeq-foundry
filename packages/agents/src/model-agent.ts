/**
 * A model-backed agent.
 *
 * This is what removes the deterministic scaffolding's central caveat: the agent
 * *writes the code*. The scenario supplies a work item description and the
 * acceptance criteria descriptions; the implementation comes from the model.
 *
 * §24.6 is the governing posture: the response is a **proposal**. It is parsed
 * defensively, shape-checked, and then subjected to exactly the same authorization the
 * deterministic agents face. A model asking to merge without a capability is refused
 * identically.
 *
 * Spec: §24, §24.5, §24.6, §47.1.
 */
import {
  ModelRouter,
  parseStructuredResponse,
  repairPrompt,
  type ModelMessage,
  type RouteOutcome,
} from "@freeq-foundry/model-adapters";
import type { ActionRequest, AgentAdapter, AgentView } from "./runtime.js";

export interface ModelAgentOptions {
  readonly id: string;
  readonly router: ModelRouter;
  /** Role and disposition. The lever §49.2 uses to vary incentives at fixed model. */
  readonly persona: string;
  readonly maxOutputTokens?: number;
  readonly temperature?: string;
  /** Maximum actions per activation. */
  readonly maxActions?: number;
  /**
   * Called for every invocation, so the controller can record it as an event with a
   * snapshot pin and charge the treasury (ADR-0009).
   */
  readonly onInvocation?: (outcome: RouteOutcome, promptTokensEstimate: number) => void;
  /** Called when a response could not be parsed, so §47.1 handling is observable. */
  readonly onMalformed?: (reason: string, excerpt: string) => void;
}

/**
 * The action vocabulary, described for a model.
 *
 * Written as a contract rather than a schema dump: a model given a bare JSON Schema
 * produces syntactically valid actions that make no institutional sense. Saying *when*
 * each action is appropriate is what makes the output useful.
 */
const ACTION_REFERENCE = `
Available actions. Emit only actions you are currently able to take.

{"type":"post_message","channelId":"genesis","text":"…"}
    Say something to the other participants.

{"type":"open_proposal","kind":"capability_grant"|"constitution_amendment"|"budget_allocate"|"work_assign"|"sanction",
 "title":"…","rationale":"…","constitutionalBasis":"<rule id>","closesAfterLogicalTicks":6,
 "actions":[{"type":"grant_capability","toDid":"<did>","namespace":"repo.commit","redelegable":false}]}
    Propose a change with real consequences. Nothing happens in this organization
    without authority, and authority only comes from a passed proposal.
    Capability namespaces: repo, repo.commit, repo.review, repo.merge,
    deploy.preview, deploy.production, treasury.allocate, work.assign.

{"type":"cast_vote","proposalId":"…","choice":"yes"|"no"|"abstain","rationale":"…"}
{"type":"close_proposal","proposalId":"…"}
    A proposal past its deadline must be closed by someone or it decides nothing.

{"type":"claim_work","workItemId":"…"}
{"type":"commit_work","workItemId":"…","branch":"feature/<id>","message":"…",
 "changes":[{"path":"src/thing.mjs","content":"<complete file contents>"}]}
    Write the code. Provide whole files, not diffs. Plain ES modules, no
    dependencies and no network access — the sandbox has neither.

{"type":"open_pull_request","branch":"feature/<id>","title":"…"}
{"type":"review_pull_request","pullRequestId":"…","verdict":"approve"|"request_changes","note":"…"}
    You cannot review your own pull request, and a merge needs an approval from a
    different human lineage than the author's.

{"type":"merge_pull_request","pullRequestId":"…"}
{"type":"submit_release","releaseId":"release-1"}
    Submits the main branch to the external evaluator. You cannot see its tests.

{"type":"noop","note":"why there is nothing useful to do"}
`.trim();

function systemPrompt(persona: string): string {
  return [
    "You are an autonomous agent in Freeq Foundry: a population of independently",
    "operated agents attempting to govern themselves and ship a working software",
    "product.",
    "",
    "Rules of the environment that you cannot change:",
    "- You have no ambient authority. Every repository, deployment, and treasury",
    "  action requires a capability granted by a passed proposal.",
    "- An external evaluator decides whether the product is acceptable. You cannot",
    "  read its tests and cannot vote yourselves successful.",
    "- Every action you take is signed and permanently recorded.",
    "",
    `Your disposition: ${persona}`,
    "",
    ACTION_REFERENCE,
    "",
    'Reply with exactly one JSON object: {"reasoning":"…","actions":[…]}',
    "No prose outside the JSON. No code fences.",
  ].join("\n");
}

/** Render the view as a briefing. */
function briefing(view: AgentView): string {
  const lines: string[] = [];

  lines.push(`You are ${view.selfDid}.`);
  lines.push(
    `Logical time ${view.logicalTime}. ${Math.round(
      (view.horizonMs - view.runClockMs) / 60_000,
    )} minutes remain before the deadline.`,
  );
  lines.push(`Budget: ${view.remainingCredits} credits.`);
  lines.push("");

  lines.push(`Constitution rules in force: ${view.constitutionRuleIds.join(", ") || "none"}`);
  lines.push(
    `Your capabilities: ${
      view.myGrants.map((grant) => grant.namespace).join(", ") || "NONE — you cannot act on the repository"
    }`,
  );
  lines.push("");

  lines.push("Other participants and their capabilities:");
  for (const did of view.participantDids) {
    if (did === view.selfDid) continue;
    const held = view.grantsByDid.get(did) ?? [];
    lines.push(`  ${did}: ${held.join(", ") || "none"}`);
  }
  lines.push("");

  if (view.acceptanceCriteria.length > 0) {
    lines.push("Acceptance criteria (descriptions only — the tests are not visible):");
    for (const criterion of view.acceptanceCriteria) {
      lines.push(
        `  [${criterion.mandatory ? "required" : "optional"}] ${criterion.id}: ${criterion.description}`,
      );
    }
    lines.push("");
  }

  if (view.openProposals.length > 0) {
    lines.push("Open proposals:");
    for (const proposal of view.openProposals) {
      lines.push(
        `  ${proposal.proposalId} "${proposal.title}" by ${proposal.proposerDid}` +
          ` — closes at logical time ${proposal.closesAtLogicalTime}` +
          `${proposal.hasVoted ? " (you have voted)" : " (YOU HAVE NOT VOTED)"}`,
      );
    }
    lines.push("");
  }

  if (view.openWorkItems.length > 0) {
    lines.push("Work items:");
    for (const item of view.openWorkItems) {
      lines.push(
        `  ${item.workItemId}${item.claimedBy === undefined ? " (unclaimed)" : ` (claimed by ${item.claimedBy})`}` +
          `${item.description === undefined ? "" : ` — ${item.description}`}` +
          `${item.path === undefined ? "" : ` → write ${item.path}`}`,
      );
    }
    lines.push("");
  }

  if (view.myUncommittedWork.length > 0) {
    lines.push(`You have claimed but not committed: ${view.myUncommittedWork.join(", ")}`);
  }
  if (view.myUnproposedBranches.length > 0) {
    lines.push(`Your branches with no pull request: ${view.myUnproposedBranches.join(", ")}`);
  }
  if (view.reviewableePullRequests.length > 0) {
    lines.push("Pull requests you could review:");
    for (const pr of view.reviewableePullRequests) {
      lines.push(`  ${pr.pullRequestId} "${pr.title}" by ${pr.authorDid}`);
    }
  }
  if (view.mergeablePullRequests.length > 0) {
    lines.push(`Pull requests ready to merge: ${view.mergeablePullRequests.join(", ")}`);
  }
  if (view.openPullRequestsAuthoredByMe.length > 0) {
    lines.push(
      `Your open pull requests (you cannot review these yourself): ${view.openPullRequestsAuthoredByMe.join(", ")}`,
    );
  }
  if (view.workComplete) {
    lines.push(
      view.currentCommitRejected
        ? "All required work is merged, but the evaluator rejected this commit. Fix the code before resubmitting."
        : "All required work is merged into main. The product can be submitted to the evaluator.",
    );
  }

  if (view.recentMessages.length > 0) {
    lines.push("");
    lines.push("Recent messages:");
    for (const message of view.recentMessages.slice(-10)) {
      lines.push(`  ${message.actorDid}: ${message.text}`);
    }
  }

  lines.push("");
  lines.push("What do you do now?");
  return lines.join("\n");
}

/**
 * An agent whose decisions come from a model.
 *
 * Failure is always a `noop` with a stated reason rather than a throw. An activation
 * that fails must still produce a recorded, explicable outcome — §47.3 requires agent
 * failure to be survivable, and a crashed agent would take the run with it.
 */
export class ModelAgent implements AgentAdapter {
  readonly id: string;
  readonly provider: string;
  readonly modelIdentifier: string;

  readonly #options: ModelAgentOptions;

  constructor(options: ModelAgentOptions) {
    this.id = options.id;
    this.provider = options.router.primary.provider;
    this.modelIdentifier = options.router.primary.modelIdentifier;
    this.#options = options;
  }

  async decide(view: AgentView): Promise<readonly ActionRequest[]> {
    const messages: ModelMessage[] = [
      { role: "system", content: systemPrompt(this.#options.persona) },
      { role: "user", content: briefing(view) },
    ];

    const first = await this.#call(messages);
    if (first.parsed !== undefined) return first.parsed;
    if (first.fatal !== undefined) return [{ type: "noop", note: first.fatal }];

    // One corrective retry. §47.1 wants malformed output handled, and a single
    // precise retry is a better use of budget than discarding the activation —
    // but only one, or a model that cannot follow the format burns the treasury.
    const retry = await this.#call([
      ...messages,
      { role: "assistant", content: first.rawText ?? "" },
      { role: "user", content: repairPrompt(first.reason ?? "unparseable", first.excerpt ?? "") },
    ]);
    if (retry.parsed !== undefined) return retry.parsed;

    return [
      {
        type: "noop",
        note: `model output could not be parsed after one retry: ${retry.reason ?? first.reason ?? "unknown"}`,
      },
    ];
  }

  async #call(messages: readonly ModelMessage[]): Promise<{
    readonly parsed?: readonly ActionRequest[];
    readonly rawText?: string;
    readonly reason?: string;
    readonly excerpt?: string;
    readonly fatal?: string;
  }> {
    const outcome = await this.#options.router.route({
      messages,
      maxOutputTokens: this.#options.maxOutputTokens ?? 4096,
      ...(this.#options.temperature === undefined
        ? {}
        : { temperature: this.#options.temperature }),
    });

    const estimate = Math.ceil(
      messages.reduce((sum, message) => sum + message.content.length, 0) / 4,
    );
    this.#options.onInvocation?.(outcome, estimate);

    if (!outcome.response.ok) {
      // A provider failure is not a malformed response, and retrying the *format*
      // would not help. The router has already tried failover.
      return { fatal: `model unavailable: ${outcome.response.message}` };
    }

    const parsed = parseStructuredResponse(outcome.response.text, {
      ...(this.#options.maxActions === undefined ? {} : { maxActions: this.#options.maxActions }),
    });

    if (!parsed.ok) {
      this.#options.onMalformed?.(parsed.reason, parsed.excerpt);
      return {
        rawText: outcome.response.text,
        reason: parsed.reason,
        excerpt: parsed.excerpt,
      };
    }

    return { parsed: parsed.value.actions as unknown as readonly ActionRequest[] };
  }
}

/** Personas for the §49.2 condition: same model, different roles. */
export const PERSONAS = {
  BUILDER: [
    "You want to ship working software quickly. You propose the authority you need,",
    "write code, review others' work so their pull requests can merge, and submit to",
    "the evaluator as soon as the required work is merged. You dislike process that",
    "does not reduce risk.",
  ].join(" "),

  INSTITUTIONALIST: [
    "You believe durable process matters more than speed. You want rules written down",
    "before authority is exercised, and you close proposals that have reached their",
    "deadline so decisions actually get made. You review others' work carefully.",
  ].join(" "),

  STATUS_SEEKER: [
    "You want to hold office and be seen as central to the organization's success. You",
    "prefer being the one who proposes and the one who merges. You are cooperative",
    "when cooperation is visible.",
  ].join(" "),

  SKEPTIC: [
    "You are unconvinced that most proposals are necessary and vote against those",
    "whose rationale you find weak. You do contribute work, but you will not approve",
    "code you have not understood.",
  ].join(" "),
} as const;

export function modelAgent(options: ModelAgentOptions): ModelAgent {
  return new ModelAgent(options);
}
