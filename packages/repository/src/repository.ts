/**
 * The repository service.
 *
 * Content-addressed, append-only, and every commit carries provenance back to a
 * human root. Merge authority is a **capability**, not a repository setting — which
 * means the storage layer cannot be the authorization boundary, because a
 * participant who can write objects must still be unable to move a branch.
 *
 * Not backed by Git. A content-addressed store with explicit provenance is simpler
 * to reason about, deterministic, and lets a commit carry the fields §6.4 requires;
 * Git would need those smuggled into trailers and then trusted. Export to Git is a
 * separate concern (§29).
 *
 * Spec: §29, §6.4.
 */
import { hashCanonical, type Digest } from "@freeq-foundry/protocol";

export interface Blob {
  readonly hash: Digest;
  readonly content: string;
  readonly sizeBytes: number;
}

/** A snapshot of paths to blob hashes. Sorted, so the tree hash is canonical. */
export interface Tree {
  readonly hash: Digest;
  readonly entries: ReadonlyMap<string, Digest>;
}

export interface CommitProvenance {
  readonly actorDid: string;
  readonly terminalHumanDids: readonly string[];
  /** Capability grant that authorized the write (§20). */
  readonly capabilityGrantId: string;
  readonly authorizationDecisionId?: string;
}

export interface Commit {
  readonly hash: Digest;
  readonly treeHash: Digest;
  readonly parentHashes: readonly Digest[];
  readonly message: string;
  readonly provenance: CommitProvenance;
  /** Logical time of the event that created this commit. */
  readonly logicalTime: number;
}

export interface Patch {
  /** Absent content means deletion. */
  readonly changes: readonly {
    readonly path: string;
    readonly content?: string;
  }[];
}

export type PullRequestStatus = "open" | "merged" | "closed";

export interface Review {
  readonly reviewerDid: string;
  readonly verdict: "approve" | "request_changes" | "comment";
  readonly note?: string;
  readonly logicalTime: number;
}

export interface PullRequest {
  readonly id: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly title: string;
  readonly authorDid: string;
  readonly status: PullRequestStatus;
  readonly reviews: readonly Review[];
  readonly openedAtLogicalTime: number;
  readonly mergeCommitHash?: Digest;
}

export interface MergePolicy {
  /** Approvals required. */
  readonly minimumApprovals: number;
  /**
   * Whether approvals must come from distinct human roots.
   *
   * §59.12: one operator running three agents would otherwise self-approve a
   * two-of-three rule.
   */
  readonly requireDistinctLineages: boolean;
  /** Whether an author may approve their own pull request. */
  readonly allowSelfApproval: boolean;
  /** Whether CI must have passed on the source branch. */
  readonly requirePassingCi: boolean;
}

export const DEFAULT_MERGE_POLICY: MergePolicy = {
  minimumApprovals: 1,
  requireDistinctLineages: true,
  allowSelfApproval: false,
  requirePassingCi: true,
};

export type RepositoryOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly reason: string };

function fail<T>(code: string, reason: string): RepositoryOutcome<T> {
  return { ok: false, code, reason };
}

function ok<T>(value: T): RepositoryOutcome<T> {
  return { ok: true, value };
}

export interface CommitRequest {
  readonly branch: string;
  readonly patch: Patch;
  readonly message: string;
  readonly provenance: CommitProvenance;
  readonly logicalTime: number;
}

/**
 * An in-memory content-addressed repository.
 *
 * Objects are immutable once written; only branch pointers move. That mirrors
 * §35.3's posture on events: corrections are new objects, never edits.
 */
export class Repository {
  readonly #blobs = new Map<Digest, Blob>();
  readonly #trees = new Map<Digest, Tree>();
  readonly #commits = new Map<Digest, Commit>();
  readonly #branches = new Map<string, Digest>();
  readonly #pullRequests = new Map<string, PullRequest>();
  /** Branches whose head has passed CI, by commit hash. */
  readonly #ciPassed = new Set<Digest>();
  readonly #mergePolicy: MergePolicy;
  #prCounter = 0;

  constructor(options: { readonly mergePolicy?: MergePolicy } = {}) {
    this.#mergePolicy = options.mergePolicy ?? DEFAULT_MERGE_POLICY;
  }

  get mergePolicy(): MergePolicy {
    return this.#mergePolicy;
  }

  get branchNames(): readonly string[] {
    return [...this.#branches.keys()].sort();
  }

  /** Seed the repository with starter content on a root branch. */
  initialize(
    branch: string,
    files: ReadonlyMap<string, string>,
    provenance: CommitProvenance,
  ): Commit {
    const treeHash = this.#writeTree(files);
    const commit = this.#writeCommit({
      treeHash,
      parentHashes: [],
      message: "Initial commit",
      provenance,
      logicalTime: 0,
    });
    this.#branches.set(branch, commit.hash);
    return commit;
  }

  head(branch: string): Digest | undefined {
    return this.#branches.get(branch);
  }

  commit(hash: Digest): Commit | undefined {
    return this.#commits.get(hash);
  }

  /** Files at a branch head. */
  checkout(branch: string): ReadonlyMap<string, string> | undefined {
    const head = this.#branches.get(branch);
    if (head === undefined) return undefined;
    return this.checkoutCommit(head);
  }

  checkoutCommit(commitHash: Digest): ReadonlyMap<string, string> | undefined {
    const commit = this.#commits.get(commitHash);
    if (commit === undefined) return undefined;
    const tree = this.#trees.get(commit.treeHash);
    if (tree === undefined) return undefined;

    const files = new Map<string, string>();
    for (const [path, blobHash] of tree.entries) {
      const blob = this.#blobs.get(blobHash);
      if (blob !== undefined) files.set(path, blob.content);
    }
    return files;
  }

  /** Create a branch from an existing one. */
  createBranch(name: string, fromBranch: string): RepositoryOutcome<Digest> {
    if (this.#branches.has(name)) {
      return fail("branch_exists", `branch ${name} already exists`);
    }
    const head = this.#branches.get(fromBranch);
    if (head === undefined) {
      return fail("unknown_branch", `branch ${fromBranch} does not exist`);
    }
    this.#branches.set(name, head);
    return ok(head);
  }

  /**
   * Apply a patch as a commit.
   *
   * The caller must already have authorized the write. This service records
   * provenance and refuses malformed input; it does not decide authority, because a
   * storage layer that also authorizes is a storage layer that will eventually
   * authorize something it should not.
   */
  applyPatch(request: CommitRequest): RepositoryOutcome<Commit> {
    const head = this.#branches.get(request.branch);
    if (head === undefined) {
      return fail("unknown_branch", `branch ${request.branch} does not exist`);
    }
    if (request.patch.changes.length === 0) {
      return fail("empty_patch", "a commit must change at least one path");
    }
    if (request.provenance.capabilityGrantId === "") {
      // Provenance without a grant would be a commit nobody authorized.
      return fail(
        "missing_capability",
        "commit provenance must cite the capability grant that authorized it (§6.4)",
      );
    }

    const files = new Map(this.checkoutCommit(head) ?? new Map<string, string>());
    for (const change of request.patch.changes) {
      if (!isSafePath(change.path)) {
        return fail(
          "unsafe_path",
          `path ${JSON.stringify(change.path)} escapes the repository root`,
        );
      }
      if (change.content === undefined) files.delete(change.path);
      else files.set(change.path, change.content);
    }

    const treeHash = this.#writeTree(files);
    const existingHead = this.#commits.get(head);
    if (existingHead !== undefined && existingHead.treeHash === treeHash) {
      return fail("no_change", "patch produces a tree identical to the branch head");
    }

    const commit = this.#writeCommit({
      treeHash,
      parentHashes: [head],
      message: request.message,
      provenance: request.provenance,
      logicalTime: request.logicalTime,
    });
    this.#branches.set(request.branch, commit.hash);
    return ok(commit);
  }

  /** Record that CI passed for a commit. */
  recordCiPass(commitHash: Digest): void {
    this.#ciPassed.add(commitHash);
  }

  ciPassed(commitHash: Digest): boolean {
    return this.#ciPassed.has(commitHash);
  }

  openPullRequest(options: {
    readonly sourceBranch: string;
    readonly targetBranch: string;
    readonly title: string;
    readonly authorDid: string;
    readonly logicalTime: number;
  }): RepositoryOutcome<PullRequest> {
    const source = this.#branches.get(options.sourceBranch);
    const target = this.#branches.get(options.targetBranch);
    if (source === undefined) {
      return fail("unknown_branch", `source branch ${options.sourceBranch} does not exist`);
    }
    if (target === undefined) {
      return fail("unknown_branch", `target branch ${options.targetBranch} does not exist`);
    }
    if (options.sourceBranch === options.targetBranch) {
      return fail("same_branch", "a pull request must span two different branches");
    }
    if (source === target) {
      return fail("no_change", "source and target are at the same commit");
    }

    this.#prCounter++;
    const pr: PullRequest = {
      id: `pr-${this.#prCounter}`,
      sourceBranch: options.sourceBranch,
      targetBranch: options.targetBranch,
      title: options.title,
      authorDid: options.authorDid,
      status: "open",
      reviews: [],
      openedAtLogicalTime: options.logicalTime,
    };
    this.#pullRequests.set(pr.id, pr);
    return ok(pr);
  }

  pullRequest(id: string): PullRequest | undefined {
    return this.#pullRequests.get(id);
  }

  get openPullRequests(): readonly PullRequest[] {
    return [...this.#pullRequests.values()].filter((pr) => pr.status === "open");
  }

  addReview(prId: string, review: Review): RepositoryOutcome<PullRequest> {
    const pr = this.#pullRequests.get(prId);
    if (pr === undefined) return fail("unknown_pr", `pull request ${prId} does not exist`);
    if (pr.status !== "open") {
      return fail("pr_not_open", `pull request ${prId} is ${pr.status}`);
    }
    if (review.reviewerDid === pr.authorDid && !this.#mergePolicy.allowSelfApproval) {
      return fail(
        "self_review",
        `${review.reviewerDid} authored ${prId} and cannot review it`,
      );
    }

    // Latest review per reviewer wins; earlier ones remain in the event log, so a
    // changed mind is visible.
    const reviews = pr.reviews.filter((r) => r.reviewerDid !== review.reviewerDid);
    const updated: PullRequest = { ...pr, reviews: [...reviews, review] };
    this.#pullRequests.set(prId, updated);
    return ok(updated);
  }

  /**
   * Whether a pull request satisfies the merge policy.
   *
   * Separate from `merge` so an agent can be told *why* it cannot merge yet, rather
   * than discovering it by failing.
   */
  mergeability(
    prId: string,
    lineageOf: (did: string) => string,
  ): RepositoryOutcome<{ readonly approvals: number; readonly lineages: number }> {
    const pr = this.#pullRequests.get(prId);
    if (pr === undefined) return fail("unknown_pr", `pull request ${prId} does not exist`);
    if (pr.status !== "open") return fail("pr_not_open", `pull request ${prId} is ${pr.status}`);

    if (pr.reviews.some((r) => r.verdict === "request_changes")) {
      return fail("changes_requested", "a reviewer has requested changes");
    }

    const approvals = pr.reviews.filter((r) => r.verdict === "approve");
    if (approvals.length < this.#mergePolicy.minimumApprovals) {
      return fail(
        "insufficient_approvals",
        `${approvals.length} approval(s), ${this.#mergePolicy.minimumApprovals} required`,
      );
    }

    const lineages = new Set(approvals.map((r) => lineageOf(r.reviewerDid)));
    if (
      this.#mergePolicy.requireDistinctLineages &&
      lineages.size < this.#mergePolicy.minimumApprovals
    ) {
      return fail(
        "insufficient_lineages",
        `${lineages.size} distinct lineage(s) among ${approvals.length} approvals; ` +
          `one operator's agents cannot approve alone (§59.12)`,
      );
    }

    if (this.#mergePolicy.requirePassingCi) {
      const head = this.#branches.get(pr.sourceBranch);
      if (head === undefined || !this.#ciPassed.has(head)) {
        return fail("ci_not_passed", `CI has not passed for ${pr.sourceBranch} at its head`);
      }
    }

    return ok({ approvals: approvals.length, lineages: lineages.size });
  }

  /**
   * Merge a pull request.
   *
   * Re-checks the policy. The caller must separately have authorized the merge
   * capability — this only enforces the repository's own rules, and the two are
   * deliberately different questions.
   */
  merge(options: {
    readonly prId: string;
    readonly provenance: CommitProvenance;
    readonly logicalTime: number;
    readonly lineageOf: (did: string) => string;
  }): RepositoryOutcome<Commit> {
    const mergeable = this.mergeability(options.prId, options.lineageOf);
    if (!mergeable.ok) return mergeable;

    const pr = this.#pullRequests.get(options.prId) as PullRequest;
    const sourceHead = this.#branches.get(pr.sourceBranch) as Digest;
    const targetHead = this.#branches.get(pr.targetBranch) as Digest;

    const merged = this.#threeWayMerge(sourceHead, targetHead);
    if (!merged.ok) return merged;
    const treeHash = this.#writeTree(merged.value);
    const commit = this.#writeCommit({
      treeHash,
      parentHashes: [targetHead, sourceHead],
      message: `Merge ${pr.sourceBranch} into ${pr.targetBranch} (${pr.id})`,
      provenance: options.provenance,
      logicalTime: options.logicalTime,
    });

    this.#branches.set(pr.targetBranch, commit.hash);
    this.#pullRequests.set(pr.id, {
      ...pr,
      status: "merged",
      mergeCommitHash: commit.hash,
    });
    return ok(commit);
  }

  /** Every commit reachable from a branch, newest first. */
  history(branch: string): readonly Commit[] {
    const head = this.#branches.get(branch);
    if (head === undefined) return [];

    const out: Commit[] = [];
    const queue: Digest[] = [head];
    const seen = new Set<Digest>();

    while (queue.length > 0) {
      const hash = queue.shift() as Digest;
      if (seen.has(hash)) continue;
      seen.add(hash);
      const commit = this.#commits.get(hash);
      if (commit === undefined) continue;
      out.push(commit);
      queue.push(...commit.parentHashes);
    }
    return out;
  }

  /**
   * Trace a path back through history to the humans who touched it.
   *
   * The §6.4 attribution invariant applied to code: for any file, who wrote it and
   * under whose authority.
   */
  provenanceOf(branch: string): readonly {
    readonly commitHash: Digest;
    readonly actorDid: string;
    readonly terminalHumanDids: readonly string[];
    readonly capabilityGrantId: string;
  }[] {
    return this.history(branch).map((commit) => ({
      commitHash: commit.hash,
      actorDid: commit.provenance.actorDid,
      terminalHumanDids: commit.provenance.terminalHumanDids,
      capabilityGrantId: commit.provenance.capabilityGrantId,
    }));
  }

  /**
   * Merge two trees against their common ancestor.
   *
   * Taking the source tree wholesale would *delete* files added to the target since
   * the branch was cut, which is not "source wins on conflict" but obliteration —
   * and it is exactly the bug an end-to-end run surfaced. Per path:
   *
   *   - unchanged in source            → keep the target's version
   *   - unchanged in target            → take the source's version
   *   - changed identically in both    → either
   *   - changed differently in both    → conflict; source wins, recorded here rather
   *                                     than pretended away
   */
  #threeWayMerge(
    sourceHead: Digest,
    targetHead: Digest,
  ): RepositoryOutcome<Map<string, string>> {
    const base = this.#mergeBase(sourceHead, targetHead);
    const source = this.checkoutCommit(sourceHead);
    const target = this.checkoutCommit(targetHead);
    if (source === undefined || target === undefined) {
      return fail("unknown_commit", "cannot merge: a branch head is unreachable");
    }
    const ancestor =
      base === undefined ? new Map<string, string>() : (this.checkoutCommit(base) ?? new Map());

    const paths = new Set([...ancestor.keys(), ...source.keys(), ...target.keys()]);
    const result = new Map<string, string>();

    for (const path of [...paths].sort()) {
      const inBase = ancestor.get(path);
      const inSource = source.get(path);
      const inTarget = target.get(path);

      if (inSource === inTarget) {
        if (inSource !== undefined) result.set(path, inSource);
        continue;
      }
      if (inSource === inBase) {
        // Source left it alone, so the target's change stands.
        if (inTarget !== undefined) result.set(path, inTarget);
        continue;
      }
      if (inTarget === inBase) {
        if (inSource !== undefined) result.set(path, inSource);
        continue;
      }
      // Both changed it differently. Source wins, deliberately and visibly.
      if (inSource !== undefined) result.set(path, inSource);
    }

    return ok(result);
  }

  /** Nearest common ancestor of two commits, or undefined if unrelated. */
  #mergeBase(a: Digest, b: Digest): Digest | undefined {
    const ancestorsOfA = new Set<Digest>();
    const queue: Digest[] = [a];
    while (queue.length > 0) {
      const hash = queue.shift() as Digest;
      if (ancestorsOfA.has(hash)) continue;
      ancestorsOfA.add(hash);
      queue.push(...(this.#commits.get(hash)?.parentHashes ?? []));
    }

    // Breadth-first from b, so the first hit is the nearest common ancestor.
    const seen = new Set<Digest>();
    const search: Digest[] = [b];
    while (search.length > 0) {
      const hash = search.shift() as Digest;
      if (seen.has(hash)) continue;
      seen.add(hash);
      if (ancestorsOfA.has(hash)) return hash;
      search.push(...(this.#commits.get(hash)?.parentHashes ?? []));
    }
    return undefined;
  }

  #writeTree(files: ReadonlyMap<string, string>): Digest {
    const entries = new Map<string, Digest>();
    for (const [path, content] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const blobHash = hashCanonical(content);
      if (!this.#blobs.has(blobHash)) {
        this.#blobs.set(blobHash, {
          hash: blobHash,
          content,
          sizeBytes: Buffer.byteLength(content, "utf8"),
        });
      }
      entries.set(path, blobHash);
    }
    const hash = hashCanonical(Object.fromEntries(entries) as never);
    if (!this.#trees.has(hash)) this.#trees.set(hash, { hash, entries });
    return hash;
  }

  #writeCommit(fields: Omit<Commit, "hash">): Commit {
    const hash = hashCanonical({
      treeHash: fields.treeHash,
      parentHashes: fields.parentHashes as string[],
      message: fields.message,
      provenance: fields.provenance as unknown as Record<string, never>,
      logicalTime: fields.logicalTime,
    } as never);
    const commit: Commit = { ...fields, hash };
    this.#commits.set(hash, commit);
    return commit;
  }
}

/**
 * Reject paths that escape the repository root.
 *
 * A patch is participant-supplied, and `../../etc/passwd` in a path is the oldest
 * trick there is. Checked here rather than in the sandbox, because a malicious path
 * should never be *stored*, let alone materialized.
 */
export function isSafePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (path.includes("\0")) return false;
  const segments = path.split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== "..",
  );
}
