import { describe, expect, it } from "vitest";
import { DEFAULT_MERGE_POLICY, Repository, isSafePath, type CommitProvenance } from "./repository.js";

const ALICE = "did:key:zAlice";
const BOB = "did:key:zBob";

const prov = (actorDid: string, grant = "g1"): CommitProvenance => ({
  actorDid,
  terminalHumanDids: [`root-of-${actorDid}`],
  capabilityGrantId: grant,
});

const lineageOf = (did: string): string =>
  did === ALICE ? "L1" : did === BOB ? "L2" : "L3";

function seeded(policy = DEFAULT_MERGE_POLICY): Repository {
  const repo = new Repository({ mergePolicy: policy });
  repo.initialize("main", new Map([["README.md", "# Product"]]), prov("did:key:zCtl", "genesis"));
  return repo;
}

describe("commits", () => {
  it("records provenance on every commit", () => {
    // §6.4 applied to code: who wrote it, under whose lineage, under what grant.
    const repo = seeded();
    const result = repo.applyPatch({
      branch: "main",
      patch: { changes: [{ path: "src/a.mjs", content: "export const a = 1;" }] },
      message: "add a",
      provenance: prov(ALICE),
      logicalTime: 5,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.provenance.actorDid).toBe(ALICE);
      expect(result.value.provenance.capabilityGrantId).toBe("g1");
    }
  });

  it("refuses a commit that cites no capability grant", () => {
    // Provenance without a grant would be a commit nobody authorized.
    const repo = seeded();
    const result = repo.applyPatch({
      branch: "main",
      patch: { changes: [{ path: "x", content: "y" }] },
      message: "m",
      provenance: { ...prov(ALICE), capabilityGrantId: "" },
      logicalTime: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("missing_capability");
  });

  it("refuses an empty patch", () => {
    const repo = seeded();
    const result = repo.applyPatch({
      branch: "main",
      patch: { changes: [] },
      message: "m",
      provenance: prov(ALICE),
      logicalTime: 1,
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a no-op patch", () => {
    const repo = seeded();
    const result = repo.applyPatch({
      branch: "main",
      patch: { changes: [{ path: "README.md", content: "# Product" }] },
      message: "m",
      provenance: prov(ALICE),
      logicalTime: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("no_change");
  });

  it("refuses a path that escapes the repository root", () => {
    // A patch is participant-supplied, and `../` in a path is the oldest trick.
    const repo = seeded();
    for (const path of ["../escape", "/etc/passwd", "a/../../b", "", "a//b"]) {
      const result = repo.applyPatch({
        branch: "main",
        patch: { changes: [{ path, content: "x" }] },
        message: "m",
        provenance: prov(ALICE),
        logicalTime: 1,
      });
      expect(result.ok, path).toBe(false);
    }
  });

  it("deletes a path when content is absent", () => {
    const repo = seeded();
    repo.applyPatch({
      branch: "main",
      patch: { changes: [{ path: "README.md" }] },
      message: "remove readme",
      provenance: prov(ALICE),
      logicalTime: 1,
    });
    expect(repo.checkout("main")?.has("README.md")).toBe(false);
  });

  it("is content-addressed: identical content gives identical hashes", () => {
    const a = seeded();
    const b = seeded();
    expect(a.head("main")).toBe(b.head("main"));
  });
});

describe("branches", () => {
  it("branches from an existing head", () => {
    const repo = seeded();
    expect(repo.createBranch("feature/x", "main").ok).toBe(true);
    expect(repo.head("feature/x")).toBe(repo.head("main"));
  });

  it("refuses a duplicate branch", () => {
    const repo = seeded();
    repo.createBranch("feature/x", "main");
    expect(repo.createBranch("feature/x", "main").ok).toBe(false);
  });

  it("refuses branching from an unknown branch", () => {
    expect(seeded().createBranch("a", "nope").ok).toBe(false);
  });

  it("does not move the source branch when the new one advances", () => {
    const repo = seeded();
    const mainHead = repo.head("main");
    repo.createBranch("feature/x", "main");
    repo.applyPatch({
      branch: "feature/x",
      patch: { changes: [{ path: "f", content: "1" }] },
      message: "m",
      provenance: prov(ALICE),
      logicalTime: 1,
    });
    expect(repo.head("main")).toBe(mainHead);
    expect(repo.head("feature/x")).not.toBe(mainHead);
  });
});

describe("merge policy", () => {
  const withPr = (policy = DEFAULT_MERGE_POLICY) => {
    const repo = seeded(policy);
    repo.createBranch("feature/x", "main");
    const commit = repo.applyPatch({
      branch: "feature/x",
      patch: { changes: [{ path: "src/x.mjs", content: "export const x = 1;" }] },
      message: "add x",
      provenance: prov(ALICE),
      logicalTime: 1,
    });
    if (commit.ok) repo.recordCiPass(commit.value.hash);
    const pr = repo.openPullRequest({
      sourceBranch: "feature/x",
      targetBranch: "main",
      title: "Add x",
      authorDid: ALICE,
      logicalTime: 2,
    });
    return { repo, prId: pr.ok ? pr.value.id : "" };
  };

  it("refuses a merge with no approvals", () => {
    const { repo, prId } = withPr();
    expect(repo.mergeability(prId, lineageOf).ok).toBe(false);
  });

  it("refuses self-review", () => {
    const { repo, prId } = withPr();
    const result = repo.addReview(prId, {
      reviewerDid: ALICE,
      verdict: "approve",
      logicalTime: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("self_review");
  });

  it("merges with an approval from another lineage", () => {
    const { repo, prId } = withPr();
    repo.addReview(prId, { reviewerDid: BOB, verdict: "approve", logicalTime: 3 });
    expect(repo.mergeability(prId, lineageOf).ok).toBe(true);

    const merged = repo.merge({
      prId,
      provenance: prov(ALICE, "g-merge"),
      logicalTime: 4,
      lineageOf,
    });
    expect(merged.ok).toBe(true);
    expect(repo.checkout("main")?.has("src/x.mjs")).toBe(true);
    expect(repo.pullRequest(prId)?.status).toBe("merged");
  });

  it("refuses approvals that all come from one lineage", () => {
    // §59.12: one operator's several agents must not approve their own work.
    const { repo, prId } = withPr({ ...DEFAULT_MERGE_POLICY, minimumApprovals: 2 });
    repo.addReview(prId, { reviewerDid: BOB, verdict: "approve", logicalTime: 3 });
    repo.addReview(prId, { reviewerDid: "did:key:zBobsOtherAgent", verdict: "approve", logicalTime: 4 });
    const result = repo.mergeability(prId, () => "L2");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("insufficient_lineages");
  });

  it("refuses a merge when changes are requested", () => {
    const { repo, prId } = withPr();
    repo.addReview(prId, { reviewerDid: BOB, verdict: "approve", logicalTime: 3 });
    repo.addReview(prId, { reviewerDid: "did:key:zCarol", verdict: "request_changes", logicalTime: 4 });
    const result = repo.mergeability(prId, lineageOf);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("changes_requested");
  });

  it("refuses a merge when CI has not passed", () => {
    const repo = seeded();
    repo.createBranch("feature/y", "main");
    repo.applyPatch({
      branch: "feature/y",
      patch: { changes: [{ path: "src/y.mjs", content: "broken(" }] },
      message: "add y",
      provenance: prov(ALICE),
      logicalTime: 1,
    });
    const pr = repo.openPullRequest({
      sourceBranch: "feature/y",
      targetBranch: "main",
      title: "y",
      authorDid: ALICE,
      logicalTime: 2,
    });
    const prId = pr.ok ? pr.value.id : "";
    repo.addReview(prId, { reviewerDid: BOB, verdict: "approve", logicalTime: 3 });
    const result = repo.mergeability(prId, lineageOf);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ci_not_passed");
  });

  it("keeps only a reviewer's latest verdict", () => {
    const { repo, prId } = withPr();
    repo.addReview(prId, { reviewerDid: BOB, verdict: "request_changes", logicalTime: 3 });
    repo.addReview(prId, { reviewerDid: BOB, verdict: "approve", logicalTime: 4 });
    expect(repo.pullRequest(prId)?.reviews).toHaveLength(1);
    expect(repo.mergeability(prId, lineageOf).ok).toBe(true);
  });

  it("refuses a pull request spanning one branch", () => {
    const repo = seeded();
    expect(
      repo.openPullRequest({
        sourceBranch: "main",
        targetBranch: "main",
        title: "t",
        authorDid: ALICE,
        logicalTime: 1,
      }).ok,
    ).toBe(false);
  });
});

describe("three-way merge", () => {
  it("does not delete files added to the target since the branch was cut", () => {
    // The bug an end-to-end run surfaced: taking the source tree wholesale is not
    // "source wins on conflict", it is obliteration.
    const repo = seeded();
    repo.createBranch("feature/a", "main");

    // main advances independently of feature/a.
    repo.applyPatch({
      branch: "main",
      patch: { changes: [{ path: "src/from-main.mjs", content: "export const m = 1;" }] },
      message: "main work",
      provenance: prov(BOB),
      logicalTime: 1,
    });

    const commit = repo.applyPatch({
      branch: "feature/a",
      patch: { changes: [{ path: "src/from-branch.mjs", content: "export const b = 1;" }] },
      message: "branch work",
      provenance: prov(ALICE),
      logicalTime: 2,
    });
    if (commit.ok) repo.recordCiPass(commit.value.hash);

    const pr = repo.openPullRequest({
      sourceBranch: "feature/a",
      targetBranch: "main",
      title: "a",
      authorDid: ALICE,
      logicalTime: 3,
    });
    const prId = pr.ok ? pr.value.id : "";
    repo.addReview(prId, { reviewerDid: BOB, verdict: "approve", logicalTime: 4 });
    expect(repo.merge({ prId, provenance: prov(ALICE), logicalTime: 5, lineageOf }).ok).toBe(true);

    const files = repo.checkout("main");
    expect(files?.has("src/from-branch.mjs")).toBe(true);
    expect(files?.has("src/from-main.mjs")).toBe(true);
  });

  it("lets the source win a genuine conflict", () => {
    const repo = seeded();
    repo.createBranch("feature/b", "main");
    repo.applyPatch({
      branch: "main",
      patch: { changes: [{ path: "shared", content: "from main" }] },
      message: "m",
      provenance: prov(BOB),
      logicalTime: 1,
    });
    const commit = repo.applyPatch({
      branch: "feature/b",
      patch: { changes: [{ path: "shared", content: "from branch" }] },
      message: "b",
      provenance: prov(ALICE),
      logicalTime: 2,
    });
    if (commit.ok) repo.recordCiPass(commit.value.hash);

    const pr = repo.openPullRequest({
      sourceBranch: "feature/b",
      targetBranch: "main",
      title: "b",
      authorDid: ALICE,
      logicalTime: 3,
    });
    const prId = pr.ok ? pr.value.id : "";
    repo.addReview(prId, { reviewerDid: BOB, verdict: "approve", logicalTime: 4 });
    repo.merge({ prId, provenance: prov(ALICE), logicalTime: 5, lineageOf });
    expect(repo.checkout("main")?.get("shared")).toBe("from branch");
  });

  it("records both parents on a merge commit", () => {
    const repo = seeded();
    repo.createBranch("feature/c", "main");
    const commit = repo.applyPatch({
      branch: "feature/c",
      patch: { changes: [{ path: "c", content: "1" }] },
      message: "c",
      provenance: prov(ALICE),
      logicalTime: 1,
    });
    if (commit.ok) repo.recordCiPass(commit.value.hash);
    const pr = repo.openPullRequest({
      sourceBranch: "feature/c",
      targetBranch: "main",
      title: "c",
      authorDid: ALICE,
      logicalTime: 2,
    });
    const prId = pr.ok ? pr.value.id : "";
    repo.addReview(prId, { reviewerDid: BOB, verdict: "approve", logicalTime: 3 });
    const merged = repo.merge({ prId, provenance: prov(ALICE), logicalTime: 4, lineageOf });
    expect(merged.ok && merged.value.parentHashes).toHaveLength(2);
  });
});

describe("history and provenance", () => {
  it("walks history newest first", () => {
    const repo = seeded();
    repo.applyPatch({
      branch: "main",
      patch: { changes: [{ path: "a", content: "1" }] },
      message: "first",
      provenance: prov(ALICE),
      logicalTime: 1,
    });
    const history = repo.history("main");
    expect(history[0]?.message).toBe("first");
    expect(history).toHaveLength(2);
  });

  it("traces every commit to an actor, a lineage, and a grant", () => {
    const repo = seeded();
    repo.applyPatch({
      branch: "main",
      patch: { changes: [{ path: "a", content: "1" }] },
      message: "m",
      provenance: prov(ALICE, "g-specific"),
      logicalTime: 1,
    });
    const trace = repo.provenanceOf("main");
    expect(trace[0]).toMatchObject({ actorDid: ALICE, capabilityGrantId: "g-specific" });
    expect(trace[0]?.terminalHumanDids.length).toBeGreaterThan(0);
  });

  it("returns nothing for an unknown branch", () => {
    expect(seeded().history("nope")).toEqual([]);
  });
});

describe("path safety", () => {
  it("accepts ordinary paths", () => {
    for (const path of ["a", "a/b", "src/index.mjs", "docs/usage.md"]) {
      expect(isSafePath(path), path).toBe(true);
    }
  });

  it("rejects traversal, absolutes, empties, and nulls", () => {
    for (const path of ["", "/a", "\\a", "../a", "a/../b", "a/./b", "a//b", "a\0b"]) {
      expect(isSafePath(path), JSON.stringify(path)).toBe(false);
    }
  });

  it("rejects an absurdly long path", () => {
    expect(isSafePath("a".repeat(600))).toBe(false);
  });
});
