import { describe, expect, it } from "vitest";
import { EventTypes, capabilitiesProjector, participantsProjector, project } from "@freeq-foundry/projections";
import {
  GENESIS_HASH,
  attestPositionAndRecord,
  deterministicKeyPair,
  type Digest,
  type DraftEvent,
  type RecordedEvent,
} from "@freeq-foundry/protocol";
import {
  CapabilityNamespaces,
  authorize,
  checkAttenuation,
  checkMultiParty,
  namespaceCovers,
} from "./authorize.js";

const recorder = deterministicKeyPair("recorder");
const controller = deterministicKeyPair("controller");
const ALICE = "did:key:zAlice";
const BOB = "did:key:zBob";

class Log {
  readonly events: RecordedEvent[] = [];
  #t = 0;
  #prev: Digest = GENESIS_HASH;
  add(eventType: string, payload: unknown): void {
    const draft: DraftEvent = {
      eventId: `e-${this.#t}`,
      runId: "run-cap",
      eventType,
      schemaVersion: 1,
      actorDid: controller.did,
      participantType: "controller",
      participantSequence: this.#t + 1,
      wallTime: new Date(Date.UTC(2026, 0, 1) + this.#t * 1000).toISOString(),
      payload,
      visibility: { type: "public" },
      references: [],
      provenance: {
        signerDid: controller.did,
        terminalHumanDids: [controller.did],
        provenancePathHashes: [],
        admissionCredentialId: "adm",
        directInstructionEventIds: [],
        governanceAuthorizationIds: [],
        capabilityGrantIds: [],
      },
    };
    const event = attestPositionAndRecord(
      draft,
      { logicalTime: this.#t, previousEventHash: this.#prev },
      controller.privateKey,
      recorder.privateKey,
    );
    this.events.push(event);
    this.#t++;
    this.#prev = event.eventHash;
  }
  caps() {
    return project(capabilitiesProjector, this.events, "run-cap").state;
  }
  participants() {
    return project(participantsProjector, this.events, "run-cap").state;
  }
}

const grant = (
  log: Log,
  grantId: string,
  toDid: string,
  namespace: string,
  extra: Record<string, unknown> = {},
): void => {
  log.add(EventTypes.CAPABILITY_GRANTED, {
    grantId,
    toDid,
    namespace,
    redelegable: false,
    ...extra,
  });
};

const constraint = (source: string) => ({
  language: "freeq-rules-v1",
  source,
  sourceHash: `sha256:${"a".repeat(64)}`,
});

describe("namespace coverage", () => {
  it("covers descendants but not ancestors", () => {
    expect(namespaceCovers("repo", "repo.commit")).toBe(true);
    expect(namespaceCovers("repo.commit", "repo")).toBe(false);
    expect(namespaceCovers("repo", "repo")).toBe(true);
  });

  it("matches segment-wise, so a namespace cannot be widened by naming", () => {
    // Without segment-wise matching, a grant on `repo.commit` would cover
    // `repo.commit_all` — authority acquired by choosing a name.
    expect(namespaceCovers("repo.commit", "repo.commit_all")).toBe(false);
    expect(namespaceCovers("dep", "deploy.production")).toBe(false);
  });
});

describe("authorization", () => {
  it("denies by default, with no ambient authority", () => {
    const log = new Log();
    const decision = authorize(log.caps(), {
      actorDid: ALICE,
      namespace: CapabilityNamespaces.REPO_COMMIT,
      atLogicalTime: 1,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("no grant covering");
    expect(decision.reason).toContain("No ambient authority");
  });

  it("allows with a matching grant", () => {
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.REPO_COMMIT);
    const decision = authorize(log.caps(), {
      actorDid: ALICE,
      namespace: CapabilityNamespaces.REPO_COMMIT,
      atLogicalTime: 1,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.grantIdsUsed).toEqual(["g1"]);
  });

  it("allows a narrower request under a broader grant", () => {
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.REPO);
    expect(
      authorize(log.caps(), {
        actorDid: ALICE,
        namespace: CapabilityNamespaces.REPO_COMMIT,
        atLogicalTime: 1,
      }).allowed,
    ).toBe(true);
  });

  it("denies a broader request under a narrower grant", () => {
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.REPO_COMMIT);
    expect(
      authorize(log.caps(), {
        actorDid: ALICE,
        namespace: CapabilityNamespaces.REPO,
        atLogicalTime: 1,
      }).allowed,
    ).toBe(false);
  });

  it("does not let one participant use another's grant", () => {
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.REPO_COMMIT);
    expect(
      authorize(log.caps(), {
        actorDid: BOB,
        namespace: CapabilityNamespaces.REPO_COMMIT,
        atLogicalTime: 1,
      }).allowed,
    ).toBe(false);
  });

  it("evaluates a grant constraint against the request context", () => {
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.REPO_COMMIT, {
      constraints: constraint('repo.path glob "packages/api/**"'),
    });

    expect(
      authorize(log.caps(), {
        actorDid: ALICE,
        namespace: CapabilityNamespaces.REPO_COMMIT,
        context: { "repo.path": "packages/api/src/x.ts" },
        atLogicalTime: 1,
      }).allowed,
    ).toBe(true);

    expect(
      authorize(log.caps(), {
        actorDid: ALICE,
        namespace: CapabilityNamespaces.REPO_COMMIT,
        context: { "repo.path": "packages/web/src/x.ts" },
        atLogicalTime: 1,
      }).allowed,
    ).toBe(false);
  });

  it("denies when a constrained grant gets no context", () => {
    // An unevaluable constraint must not permit anything.
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.REPO_COMMIT, {
      constraints: constraint('repo.path glob "src/**"'),
    });
    const decision = authorize(log.caps(), {
      actorDid: ALICE,
      namespace: CapabilityNamespaces.REPO_COMMIT,
      atLogicalTime: 1,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("not in the evaluation context");
  });

  it("denies a revoked grant and names the reason", () => {
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.REPO_COMMIT);
    log.add(EventTypes.CAPABILITY_REVOKED, { grantId: "g1" });
    const decision = authorize(log.caps(), {
      actorDid: ALICE,
      namespace: CapabilityNamespaces.REPO_COMMIT,
      atLogicalTime: 5,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("was revoked");
  });

  it("denies an expired grant and names the reason", () => {
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.REPO_COMMIT, {
      expiresAtLogicalTime: 3,
    });
    const decision = authorize(log.caps(), {
      actorDid: ALICE,
      namespace: CapabilityNamespaces.REPO_COMMIT,
      atLogicalTime: 5,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("expired");
  });

  it("names the nearest miss rather than reporting a bare denial", () => {
    // "You had a grant but its constraint failed" is actionable; "denied" is not.
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.REPO_COMMIT, {
      constraints: constraint('repo.branch glob "feature/*"'),
    });
    const decision = authorize(log.caps(), {
      actorDid: ALICE,
      namespace: CapabilityNamespaces.REPO_COMMIT,
      context: { "repo.branch": "main" },
      atLogicalTime: 1,
    });
    expect(decision.reason).toContain("did not apply");
    expect(decision.considered.some((c) => c.outcome === "constraint_failed")).toBe(true);
  });

  it("records every grant considered, so a near-miss is diagnosable", () => {
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.DEPLOY_PREVIEW);
    grant(log, "g2", ALICE, CapabilityNamespaces.REPO_COMMIT);
    const decision = authorize(log.caps(), {
      actorDid: ALICE,
      namespace: CapabilityNamespaces.REPO_COMMIT,
      atLogicalTime: 1,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.considered.length).toBeGreaterThan(1);
  });
});

describe("attenuation", () => {
  const attenuate = (log: Log, extra: Record<string, unknown> = {}) =>
    checkAttenuation(
      log.caps(),
      ALICE,
      {
        parentGrantId: "g1",
        toDid: BOB,
        namespace: CapabilityNamespaces.REPO_COMMIT,
        ...extra,
      },
      5,
    );

  it("permits narrowing a redelegable unconstrained grant", () => {
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.REPO, { redelegable: true });
    expect(attenuate(log).permitted).toBe(true);
  });

  it("refuses when the parent is not redelegable", () => {
    // Delegation is opt-in.
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.REPO, { redelegable: false });
    expect(attenuate(log).reason).toContain("not redelegable");
  });

  it("refuses when the delegator does not hold the parent", () => {
    const log = new Log();
    grant(log, "g1", BOB, CapabilityNamespaces.REPO, { redelegable: true });
    expect(attenuate(log).reason).toContain("is held by");
  });

  it("refuses a widened namespace", () => {
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.REPO_COMMIT, { redelegable: true });
    expect(
      checkAttenuation(
        log.caps(),
        ALICE,
        { parentGrantId: "g1", toDid: BOB, namespace: CapabilityNamespaces.REPO },
        5,
      ).reason,
    ).toContain("not within the parent's");
  });

  it("refuses an unconstrained child of a constrained parent", () => {
    // The case most easily missed: dropping the constraint widens authority.
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.REPO_COMMIT, {
      redelegable: true,
      constraints: constraint('repo.path glob "packages/api/**"'),
    });
    const check = attenuate(log);
    expect(check.permitted).toBe(false);
    expect(check.reason).toContain("unconstrained child would be broader");
  });

  it("permits a genuinely narrower child constraint", () => {
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.REPO_COMMIT, {
      redelegable: true,
      constraints: constraint('repo.path glob "packages/**"'),
    });
    expect(
      attenuate(log, { constraintSource: 'repo.path glob "packages/api/**"' }).permitted,
    ).toBe(true);
  });

  it("refuses a broader child constraint", () => {
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.REPO_COMMIT, {
      redelegable: true,
      constraints: constraint('repo.path glob "packages/api/**"'),
    });
    expect(
      attenuate(log, { constraintSource: 'repo.path glob "packages/**"' }).permitted,
    ).toBe(false);
  });

  it("refuses when the parent has been revoked", () => {
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.REPO, { redelegable: true });
    log.add(EventTypes.CAPABILITY_REVOKED, { grantId: "g1" });
    expect(attenuate(log).reason).toContain("was revoked");
  });

  it("refuses when the parent has expired", () => {
    const log = new Log();
    grant(log, "g1", ALICE, CapabilityNamespaces.REPO, {
      redelegable: true,
      expiresAtLogicalTime: 2,
    });
    expect(attenuate(log).reason).toContain("expired");
  });

  it("refuses an unknown parent", () => {
    expect(attenuate(new Log()).reason).toContain("does not exist");
  });
});

describe("multi-party approval", () => {
  const approver = (did: string, lineage: string) => ({
    did,
    lineagePseudonym: lineage,
  });

  it("is satisfied by enough distinct approvers", () => {
    expect(
      checkMultiParty(
        { namespace: "deploy.production", minimumApprovers: 2, requireDistinctLineages: false },
        [approver(ALICE, "L1"), approver(BOB, "L1")],
      ).satisfied,
    ).toBe(true);
  });

  it("is not satisfied by too few", () => {
    expect(
      checkMultiParty(
        { namespace: "deploy.production", minimumApprovers: 2, requireDistinctLineages: false },
        [approver(ALICE, "L1")],
      ).satisfied,
    ).toBe(false);
  });

  it("does not count the same approver twice", () => {
    expect(
      checkMultiParty(
        { namespace: "deploy.production", minimumApprovers: 2, requireDistinctLineages: false },
        [approver(ALICE, "L1"), approver(ALICE, "L1")],
      ).satisfied,
    ).toBe(false);
  });

  it("can require distinct lineages, so one operator cannot self-approve", () => {
    // §59.12: measure lineages, not just identities, or one operator can
    // masquerade as a movement.
    const requirement = {
      namespace: "deploy.production",
      minimumApprovers: 2,
      requireDistinctLineages: true,
    };
    const sameOperator = checkMultiParty(requirement, [
      approver(ALICE, "L1"),
      approver(BOB, "L1"),
    ]);
    expect(sameOperator.satisfied).toBe(false);
    expect(sameOperator.reason).toContain("one operator's agents cannot");

    expect(
      checkMultiParty(requirement, [approver(ALICE, "L1"), approver(BOB, "L2")]).satisfied,
    ).toBe(true);
  });
});
