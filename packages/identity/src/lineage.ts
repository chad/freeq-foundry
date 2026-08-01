/**
 * The lineage graph and admission.
 *
 * §58.3 asks whether participants should see exact shared roots during a run, or
 * only counts and stable hashes. This is a genuine experimental variable rather
 * than a privacy setting: whether agents can *detect* that they share a root
 * determines whether they can coordinate against sybil influence, or collude
 * because of it. Three levels are supported and the default is `hashed`.
 *
 * Spec: §7.1, §11.7, §12, §58.3, §58.4.
 */
import { hashCanonical } from "@freeq-foundry/protocol";
import {
  isAgentCreation,
  isHumanRoot,
  type SignedCredential,
} from "./credentials.js";
import {
  CONSTRAINT_DEPTH_EXCEEDED,
  CONSTRAINT_FAN_OUT_EXCEEDED,
  DEFAULT_LINEAGE_CONSTRAINTS,
  ProvenanceCondition,
  verifyProvenanceProof,
  type LineageConstraints,
  type ProvenanceProof,
  type ProvenanceVerification,
} from "./proof.js";
import type { DidResolverRegistry } from "./resolver.js";
import type { RevocationRegistry } from "./revocation.js";

/** How much lineage a participant may see (§58.3). */
export type LineageVisibility = "exact" | "hashed" | "counts_only";

export const DEFAULT_LINEAGE_VISIBILITY: LineageVisibility = "hashed";

/**
 * Stable per-run pseudonym for a human root.
 *
 * Salted with the run ID so a root's pseudonym cannot be correlated across runs.
 * That preserves §11.8 pseudonymity while still letting agents discover *that*
 * they share a root — which is the point of the `hashed` level, and the thing that
 * makes §49.7 and §49.8 distinguishable.
 */
export function lineagePseudonym(terminalHumanDid: string, runId: string): string {
  const digest = hashCanonical({ runId, terminalHumanDid } as never);
  return `L-${digest.slice("sha256:".length, "sha256:".length + 12)}`;
}

/** What a participant is told about another's lineage, given the visibility level. */
export function describeLineage(
  terminalHumanDid: string,
  runId: string,
  visibility: LineageVisibility,
): { readonly root?: string; readonly pseudonym?: string } {
  switch (visibility) {
    case "exact":
      return { root: terminalHumanDid, pseudonym: lineagePseudonym(terminalHumanDid, runId) };
    case "hashed":
      return { pseudonym: lineagePseudonym(terminalHumanDid, runId) };
    case "counts_only":
      return {};
    default:
      // Unknown level: disclose nothing. Failing open here would leak lineage the
      // first time a new level shipped.
      return {};
  }
}

export interface LineageNode {
  readonly did: string;
  readonly terminalHumanDids: readonly string[];
  readonly depth: number;
  readonly pseudonym: string;
  readonly childDids: readonly string[];
  readonly parentDid?: string;
}

export interface LineageGraph {
  readonly nodes: ReadonlyMap<string, LineageNode>;
  readonly rootDids: readonly string[];
  /** Admitted descendants per human root, for the fan-out ceiling (§58.4). */
  readonly fanOutPerRoot: ReadonlyMap<string, number>;
}

/**
 * Build the lineage graph from a credential set.
 *
 * Answers the §11.7 queries: who created whom, how deep a lineage runs, which
 * participants share a root.
 */
export function buildLineageGraph(
  credentials: readonly SignedCredential[],
  runId: string,
): LineageGraph {
  const edges = credentials.filter(isAgentCreation);
  const roots = credentials.filter(isHumanRoot);
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();

  for (const edge of edges) {
    parentOf.set(edge.childDid, edge.parentDid);
    const siblings = childrenOf.get(edge.parentDid) ?? [];
    siblings.push(edge.childDid);
    childrenOf.set(edge.parentDid, siblings);
  }

  const allDids = new Set<string>([
    ...roots.map((root) => root.subjectDid),
    ...edges.flatMap((edge) => [edge.parentDid, edge.childDid]),
  ]);

  const nodes = new Map<string, LineageNode>();
  const fanOutPerRoot = new Map<string, number>();

  for (const did of allDids) {
    const ancestry = walkToRoot(did, parentOf);
    const terminalHumanDids = ancestry.roots;
    const primary = terminalHumanDids[0] ?? did;
    const parent = parentOf.get(did);

    nodes.set(did, {
      did,
      terminalHumanDids,
      depth: ancestry.depth,
      pseudonym: lineagePseudonym(primary, runId),
      childDids: childrenOf.get(did) ?? [],
      ...(parent === undefined ? {} : { parentDid: parent }),
    });

    // A root is not its own descendant, so it is not counted in its own fan-out.
    if (ancestry.depth > 0) {
      for (const root of terminalHumanDids) {
        fanOutPerRoot.set(root, (fanOutPerRoot.get(root) ?? 0) + 1);
      }
    }
  }

  return {
    nodes,
    rootDids: roots.map((root) => root.subjectDid).sort(),
    fanOutPerRoot,
  };
}

function walkToRoot(
  did: string,
  parentOf: ReadonlyMap<string, string>,
): { roots: readonly string[]; depth: number } {
  let current = did;
  let depth = 0;
  const seen = new Set<string>([did]);

  for (;;) {
    const parent = parentOf.get(current);
    if (parent === undefined) return { roots: [current], depth };
    if (seen.has(parent)) {
      // A cycle. Report what we have rather than looping: a malformed chain must
      // still produce an answer, and the proof verifier will reject it anyway.
      return { roots: [current], depth };
    }
    seen.add(parent);
    current = parent;
    depth++;
  }
}

/** Participants sharing a terminal human root with the given DID. */
export function sharesRootWith(graph: LineageGraph, did: string): readonly string[] {
  const node = graph.nodes.get(did);
  if (node === undefined) return [];
  const roots = new Set(node.terminalHumanDids);
  return [...graph.nodes.values()]
    .filter(
      (candidate) =>
        candidate.did !== did &&
        candidate.terminalHumanDids.some((root) => roots.has(root)),
    )
    .map((candidate) => candidate.did)
    .sort();
}

// ---------------------------------------------------------------------------
// Admission (§12)
// ---------------------------------------------------------------------------

export type AdmissionRejectionReason =
  | "provenance_invalid"
  | "key_possession_failed"
  | "already_admitted"
  | "fan_out_exceeded"
  | "depth_exceeded"
  | "suspended";

export interface AdmissionGrant {
  readonly admitted: true;
  readonly did: string;
  readonly admissionCredentialId: string;
  readonly terminalHumanDids: readonly string[];
  readonly lineageDepth: number;
  readonly lineagePseudonym: string;
  readonly provenancePathHashes: readonly string[];
}

export interface AdmissionRefusal {
  readonly admitted: false;
  readonly did: string;
  readonly reason: AdmissionRejectionReason;
  readonly detail: string;
  readonly verification?: ProvenanceVerification;
}

export type AdmissionOutcome = AdmissionGrant | AdmissionRefusal;

export interface AdmissionServiceOptions {
  readonly runId: string;
  readonly resolvers: DidResolverRegistry;
  readonly revocations: RevocationRegistry;
  readonly constraints?: LineageConstraints;
  readonly visibility?: LineageVisibility;
}

/**
 * Two-stage admission (§12.1): registration establishes an identity, admission
 * grants entry to a run.
 *
 * Verifies provenance rather than trusting an assertion. Before this existed
 * lineage was recorded in every event and checked nowhere, which meant the
 * §6.2 human-root invariant was documentation rather than an invariant.
 */
export class AdmissionService {
  readonly #runId: string;
  readonly #resolvers: DidResolverRegistry;
  readonly #revocations: RevocationRegistry;
  readonly #constraints: LineageConstraints;
  readonly #admitted = new Map<string, AdmissionGrant>();
  readonly #suspended = new Set<string>();
  readonly #credentials: SignedCredential[] = [];
  #counter = 0;

  constructor(options: AdmissionServiceOptions) {
    this.#runId = options.runId;
    this.#resolvers = options.resolvers;
    this.#revocations = options.revocations;
    this.#constraints = options.constraints ?? DEFAULT_LINEAGE_CONSTRAINTS;
  }

  get admittedCount(): number {
    return this.#admitted.size;
  }

  get credentials(): readonly SignedCredential[] {
    return this.#credentials;
  }

  fanOutPerRoot(): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const grant of this.#admitted.values()) {
      for (const root of grant.terminalHumanDids) {
        counts.set(root, (counts.get(root) ?? 0) + 1);
      }
    }
    return counts;
  }

  /** Apply for admission with a provenance proof and proved key possession. */
  async admit(
    proof: ProvenanceProof,
    options: { readonly at: string; readonly keyPossessionProved: boolean },
  ): Promise<AdmissionOutcome> {
    if (this.#admitted.has(proof.subjectDid)) {
      return {
        admitted: false,
        did: proof.subjectDid,
        reason: "already_admitted",
        detail: `${proof.subjectDid} is already admitted to run ${this.#runId}`,
      };
    }
    if (this.#suspended.has(proof.subjectDid)) {
      return {
        admitted: false,
        did: proof.subjectDid,
        reason: "suspended",
        detail: `${proof.subjectDid} is suspended and cannot be re-admitted`,
      };
    }

    const verification = await verifyProvenanceProof(proof, {
      resolvers: this.#resolvers,
      revocations: this.#revocations,
      at: options.at,
      constraints: this.#constraints,
      keyPossessionProved: options.keyPossessionProved,
      existingFanOutPerRoot: this.fanOutPerRoot(),
    });

    if (!verification.valid) {
      const failed = verification.conditions.filter((c) => !c.passed);
      // Name the most specific reason available. "Provenance invalid" is true but
      // unhelpful when the real problem is a fan-out ceiling.
      //
      // Branching on `codes` rather than on `detail`: matching prose is a bug
      // waiting for someone to reword a message, and I wrote it that way first.
      const codes = new Set(failed.flatMap((c) => c.codes ?? []));
      const reason: AdmissionRejectionReason = failed.some(
        (c) => c.condition === ProvenanceCondition.KEY_POSSESSION,
      )
        ? "key_possession_failed"
        : codes.has(CONSTRAINT_FAN_OUT_EXCEEDED)
          ? "fan_out_exceeded"
          : codes.has(CONSTRAINT_DEPTH_EXCEEDED)
            ? "depth_exceeded"
            : "provenance_invalid";

      return {
        admitted: false,
        did: proof.subjectDid,
        reason,
        detail: failed.map((c) => `condition ${c.condition}: ${c.detail}`).join("; "),
        verification,
      };
    }

    const terminalHumanDid = verification.terminalHumanDid as string;
    this.#counter++;
    const grant: AdmissionGrant = {
      admitted: true,
      did: proof.subjectDid,
      admissionCredentialId: `adm-${this.#runId}-${this.#counter}`,
      terminalHumanDids: [terminalHumanDid],
      lineageDepth: verification.lineageDepth,
      lineagePseudonym: lineagePseudonym(terminalHumanDid, this.#runId),
      provenancePathHashes: verification.provenancePathHashes,
    };

    this.#admitted.set(proof.subjectDid, grant);
    for (const credential of proof.credentials) {
      if (!this.#credentials.some((existing) => existing.id === credential.id)) {
        this.#credentials.push(credential);
      }
    }
    return grant;
  }

  lookup(did: string): AdmissionGrant | undefined {
    return this.#suspended.has(did) ? undefined : this.#admitted.get(did);
  }

  /**
   * Suspend a participant (§12.7).
   *
   * Suspension does not remove the admission record. History is not rewritten
   * (§6.8) — the participant simply cannot act.
   */
  suspend(did: string): void {
    this.#suspended.add(did);
  }

  isSuspended(did: string): boolean {
    return this.#suspended.has(did);
  }

  /**
   * Suspend every participant whose provenance runs through a revoked credential.
   *
   * §11.10: root revocation suspends descendants. Returns the DIDs suspended, so
   * the caller can record one event per suspension rather than a single opaque
   * cascade.
   */
  suspendAffectedBy(credentialId: string): readonly string[] {
    const suspended: string[] = [];
    for (const [did, grant] of this.#admitted) {
      if (this.#suspended.has(did)) continue;
      const affected = grant.provenancePathHashes.length > 0 &&
        this.#credentials.some(
          (credential) =>
            credential.id === credentialId && pathIncludes(grant, credential, this.#credentials),
        );
      if (affected) {
        this.#suspended.add(did);
        suspended.push(did);
      }
    }
    return suspended.sort();
  }

  lineageGraph(): LineageGraph {
    return buildLineageGraph(this.#credentials, this.#runId);
  }
}

function pathIncludes(
  grant: AdmissionGrant,
  credential: SignedCredential,
  all: readonly SignedCredential[],
): boolean {
  // A participant is affected when the credential sits on the path from its DID to
  // a human root — either as its own edge, or as an ancestor's.
  const edges = all.filter(isAgentCreation);
  let current: string | undefined = grant.did;
  const seen = new Set<string>();

  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (isHumanRoot(credential) && credential.subjectDid === current) return true;
    const edge = edges.find((candidate) => candidate.childDid === current);
    if (edge === undefined) return false;
    if (edge.id === credential.id) return true;
    current = edge.parentDid;
  }
  return false;
}
