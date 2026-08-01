/**
 * @freeq-foundry/repository
 *
 * Merge authority is a capability, not a repository setting — so the storage layer
 * is deliberately not the authorization boundary (§29).
 */
export {
  DEFAULT_MERGE_POLICY,
  Repository,
  isSafePath,
  type Blob,
  type Commit,
  type CommitProvenance,
  type CommitRequest,
  type MergePolicy,
  type Patch,
  type PullRequest,
  type PullRequestStatus,
  type RepositoryOutcome,
  type Review,
  type Tree,
} from "./repository.js";
