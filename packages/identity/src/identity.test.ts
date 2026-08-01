import { deterministicKeyPair, generateKeyPair } from "@freeq-foundry/protocol";
import { describe, expect, it } from "vitest";
import {
  buildProvenanceProof,
  computeChainHash,
  ProvenanceCondition,
  verifyProvenanceProof,
  type ProvenanceProof,
} from "./proof.js";
import {
  credentialHash,
  issueAgentCreationCredential,
  issueHumanRootCredential,
  verifyCredentialSignature,
  type AgentCreationCredential,
  type HumanRootCredential,
  type SignedCredential,
} from "./credentials.js";
import {
  DidKeyResolver,
  DidResolverRegistry,
  defaultResolvers,
  methodValidAt,
} from "./resolver.js";
import {
  RevocationRegistry,
  computeBlastRadius,
  signRevocation,
  verifyRevocationSignature,
} from "./revocation.js";
import {
  ChallengeRegistry,
  createChallenge,
  respondToChallenge,
  verifyChallengeResponse,
} from "./challenge.js";
import {
  AdmissionService,
  buildLineageGraph,
  describeLineage,
  lineagePseudonym,
  sharesRootWith,
} from "./lineage.js";

const controller = deterministicKeyPair("controller");
const human = deterministicKeyPair("human-one");
const agentA = deterministicKeyPair("agent-a");
const agentB = deterministicKeyPair("agent-b");
const agentC = deterministicKeyPair("agent-c");

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T01:00:00.000Z";
const T2 = "2026-01-01T02:00:00.000Z";
const T3 = "2026-01-01T03:00:00.000Z";

const root = (overrides: Partial<Parameters<typeof issueHumanRootCredential>[0]> = {}) =>
  issueHumanRootCredential({
    id: "hrc-1",
    subjectDid: human.did,
    issuerDid: controller.did,
    issuerPrivateKey: controller.privateKey,
    verificationMethod: "controller_issued",
    issuedAt: T0,
    ...overrides,
  });

const edge = (
  id: string,
  parent: ReturnType<typeof deterministicKeyPair>,
  child: ReturnType<typeof deterministicKeyPair>,
  overrides: Partial<Parameters<typeof issueAgentCreationCredential>[0]> = {},
) =>
  issueAgentCreationCredential({
    id,
    parentDid: parent.did,
    childDid: child.did,
    parentPrivateKey: parent.privateKey,
    relationship: "created",
    issuedAt: T1,
    redelegable: true,
    ...overrides,
  });

const verify = (
  proof: ProvenanceProof,
  options: {
    readonly at?: string;
    readonly revocations?: RevocationRegistry;
    readonly keyPossessionProved?: boolean;
    readonly fanOut?: ReadonlyMap<string, number>;
    readonly constraints?: Parameters<typeof verifyProvenanceProof>[1]["constraints"];
  } = {},
) =>
  verifyProvenanceProof(proof, {
    resolvers: defaultResolvers(),
    revocations: options.revocations ?? new RevocationRegistry(),
    at: options.at ?? T2,
    keyPossessionProved: options.keyPossessionProved ?? true,
    ...(options.constraints === undefined ? {} : { constraints: options.constraints }),
    ...(options.fanOut === undefined ? {} : { existingFanOutPerRoot: options.fanOut }),
  });

const failed = (verification: Awaited<ReturnType<typeof verify>>) =>
  verification.conditions.filter((c) => !c.passed).map((c) => c.condition);

describe("did:key resolution", () => {
  it("resolves offline, as a pure function of the identifier", () => {
    const resolution = new DidKeyResolver().resolve(agentA.did);
    expect(resolution.document.id).toBe(agentA.did);
    expect(resolution.document.verificationMethods).toHaveLength(1);
  });

  it("is always historically accurate, because did:key has no history", () => {
    // Not because it consults history — because there is none to consult. A
    // resolver that could not answer a historical question must say so.
    expect(new DidKeyResolver().resolve(agentA.did).historicallyAccurate).toBe(true);
  });

  it("refuses an unregistered method rather than guessing", async () => {
    const registry = new DidResolverRegistry().register(new DidKeyResolver());
    await expect(registry.resolve("did:web:example.com")).rejects.toThrow(
      /no resolver registered for did:web/,
    );
  });

  it("reports which methods it supports", () => {
    expect(defaultResolvers().methods).toEqual(["key"]);
  });

  it("bounds validity windows on verification methods", () => {
    const method = {
      id: "m",
      controller: "did:key:zA",
      publicKeyHex: "aa",
      validFrom: T1,
      validUntil: T2,
    };
    expect(methodValidAt(method, T0)).toBe(false);
    expect(methodValidAt(method, T1)).toBe(true);
    expect(methodValidAt(method, T3)).toBe(false);
  });
});

describe("credentials", () => {
  it("verifies a human-root signature", () => {
    expect(verifyCredentialSignature(root())).toBe(true);
  });

  it("verifies an agent-creation signature", () => {
    expect(verifyCredentialSignature(edge("acc-1", human, agentA))).toBe(true);
  });

  it("rejects a tampered credential", () => {
    const tampered = { ...root(), subjectDid: agentA.did };
    expect(verifyCredentialSignature(tampered)).toBe(false);
  });

  it("rejects a credential signed by the wrong key", () => {
    const forged = issueAgentCreationCredential({
      id: "acc-forged",
      parentDid: human.did,
      childDid: agentA.did,
      parentPrivateKey: agentC.privateKey, // not the parent
      relationship: "created",
      issuedAt: T1,
    });
    expect(verifyCredentialSignature(forged)).toBe(false);
  });

  it("defaults to the restrictive options", () => {
    // A credential that is accidentally irrevocable or accidentally redelegable is
    // a hole that is hard to close later, so both must be asked for.
    const credential = issueAgentCreationCredential({
      id: "acc-default",
      parentDid: human.did,
      childDid: agentA.did,
      parentPrivateKey: human.privateKey,
      relationship: "created",
      issuedAt: T1,
    });
    expect(credential.revocable).toBe(true);
    expect(credential.redelegable).toBe(false);
  });

  it("hashes stably regardless of key order", () => {
    const credential = root();
    const reordered = JSON.parse(
      JSON.stringify(credential, Object.keys(credential).sort()),
    ) as HumanRootCredential;
    expect(credentialHash(reordered)).toBe(credentialHash(credential));
  });

  it("does not verify a human-root signature as an agent-creation one", () => {
    // Domain separation across credential types (ADR-0005).
    const human_root = root();
    const asEdge = {
      ...edge("acc-x", human, agentA),
      parentSignature: human_root.issuerSignature,
    };
    expect(verifyCredentialSignature(asEdge)).toBe(false);
  });
});

describe("provenance proof: all nine conditions", () => {
  const chain = (): readonly SignedCredential[] => [edge("acc-1", human, agentA), root()];

  it("accepts a valid one-edge chain", async () => {
    const verification = await verify(buildProvenanceProof(agentA.did, chain()));
    expect(failed(verification)).toEqual([]);
    expect(verification.valid).toBe(true);
    expect(verification.terminalHumanDid).toBe(human.did);
    expect(verification.lineageDepth).toBe(1);
  });

  it("accepts a human presenting only their own root", async () => {
    const verification = await verify(buildProvenanceProof(human.did, [root()]));
    expect(verification.valid).toBe(true);
    expect(verification.lineageDepth).toBe(0);
  });

  it("1: rejects a subject that is not the first child", async () => {
    const proof = buildProvenanceProof(agentB.did, chain());
    expect(failed(await verify(proof))).toContain(ProvenanceCondition.SUBJECT_MATCHES);
  });

  it("2: rejects a broken edge", async () => {
    // agentB's parent is agentA, but agentA has no edge to the human root.
    const broken = [edge("acc-2", agentA, agentB), root()];
    const proof = buildProvenanceProof(agentB.did, broken);
    expect(failed(await verify(proof))).toContain(ProvenanceCondition.EDGES_CONNECT);
  });

  it("2: rejects a chain whose parent did not permit redelegation", async () => {
    // §11.6: an agent may only create descendants if its own credential allows it.
    const chainWithoutRedelegation = [
      edge("acc-2", agentA, agentB),
      edge("acc-1", human, agentA, { redelegable: false }),
      root(),
    ];
    const proof = buildProvenanceProof(agentB.did, chainWithoutRedelegation);
    const verification = await verify(proof);
    expect(failed(verification)).toContain(ProvenanceCondition.EDGES_CONNECT);
    expect(
      verification.conditions.find((c) => c.condition === 2)?.detail,
    ).toContain("does not permit redelegation");
  });

  it("3: rejects a chain with a bad signature", async () => {
    const tampered = [
      { ...edge("acc-1", human, agentA), purpose: ["altered"] } as AgentCreationCredential,
      root(),
    ];
    const proof = buildProvenanceProof(agentA.did, tampered);
    expect(failed(await verify(proof))).toContain(ProvenanceCondition.SIGNATURES_VERIFY);
  });

  it("4: is satisfied for did:key, whose keys cannot be retired", async () => {
    // Honest note: this condition is trivially met by did:key. It becomes
    // load-bearing with did:web, which is why it is checked rather than assumed.
    const verification = await verify(buildProvenanceProof(agentA.did, chain()));
    expect(
      verification.conditions.find((c) => c.condition === 4)?.passed,
    ).toBe(true);
  });

  it("5: rejects an expired credential", async () => {
    const expiring = [
      edge("acc-1", human, agentA, { expiresAt: T1 }),
      root(),
    ];
    const proof = buildProvenanceProof(agentA.did, expiring);
    expect(failed(await verify(proof, { at: T3 }))).toContain(
      ProvenanceCondition.NOT_EXPIRED,
    );
  });

  it("5: rejects a future-dated credential", async () => {
    const future = [edge("acc-1", human, agentA, { issuedAt: T3 }), root()];
    const proof = buildProvenanceProof(agentA.did, future);
    expect(failed(await verify(proof, { at: T1 }))).toContain(
      ProvenanceCondition.NOT_EXPIRED,
    );
  });

  it("6: rejects a revoked credential, as of the action time", async () => {
    const revocations = new RevocationRegistry();
    revocations.revoke(
      signRevocation(
        {
          credentialId: "acc-1",
          revokerDid: human.did,
          reasonCode: "key_compromise",
          effectiveAt: T2,
        },
        human.privateKey,
      ),
    );
    const proof = buildProvenanceProof(agentA.did, chain());
    expect(failed(await verify(proof, { at: T3, revocations }))).toContain(
      ProvenanceCondition.NOT_REVOKED,
    );
  });

  it("6: accepts an action taken before the revocation took effect", async () => {
    // §6.8: revocation does not make past actions unhappen.
    const revocations = new RevocationRegistry();
    revocations.revoke(
      signRevocation(
        {
          credentialId: "acc-1",
          revokerDid: human.did,
          reasonCode: "operator_request",
          effectiveAt: T3,
        },
        human.privateKey,
      ),
    );
    const proof = buildProvenanceProof(agentA.did, chain());
    expect((await verify(proof, { at: T2, revocations })).valid).toBe(true);
  });

  it("7: rejects a claimed terminal root that is not the chain's", async () => {
    const proof: ProvenanceProof = {
      ...buildProvenanceProof(agentA.did, chain()),
      terminalHumanDid: agentC.did,
    };
    expect(failed(await verify(proof))).toContain(
      ProvenanceCondition.HUMAN_ROOT_ACCEPTED,
    );
  });

  it("7: rejects a verification method the scenario does not accept", async () => {
    const proof = buildProvenanceProof(agentA.did, chain());
    const verification = await verify(proof, {
      constraints: {
        maxDepth: 4,
        maxFanOutPerRoot: 8,
        acceptedVerificationMethods: ["proof_of_personhood"],
      },
    });
    expect(failed(verification)).toContain(ProvenanceCondition.HUMAN_ROOT_ACCEPTED);
  });

  it("8: rejects an unproved key", async () => {
    // Resolution establishes which key; only a signature establishes who holds it.
    const proof = buildProvenanceProof(agentA.did, chain());
    const verification = await verify(proof, { keyPossessionProved: false });
    expect(failed(verification)).toContain(ProvenanceCondition.KEY_POSSESSION);
    expect(
      verification.conditions.find((c) => c.condition === 8)?.detail,
    ).toContain("not who holds it");
  });

  it("9: rejects a lineage deeper than the limit", async () => {
    const deep = [
      edge("acc-3", agentB, agentC),
      edge("acc-2", agentA, agentB),
      edge("acc-1", human, agentA),
      root(),
    ];
    const proof = buildProvenanceProof(agentC.did, deep);
    expect(
      failed(await verify(proof, { constraints: { maxDepth: 2, maxFanOutPerRoot: 8 } })),
    ).toContain(ProvenanceCondition.SCENARIO_CONSTRAINTS);
  });

  it("9: rejects a root at its fan-out ceiling", async () => {
    const proof = buildProvenanceProof(agentA.did, chain());
    const verification = await verify(proof, {
      constraints: { maxDepth: 4, maxFanOutPerRoot: 2 },
      fanOut: new Map([[human.did, 2]]),
    });
    expect(failed(verification)).toContain(ProvenanceCondition.SCENARIO_CONSTRAINTS);
    expect(
      verification.conditions.find((c) => c.condition === 9)?.detail,
    ).toContain("platform ceiling");
  });

  it("rejects a declared chain hash that does not match the credentials", async () => {
    const proof: ProvenanceProof = {
      ...buildProvenanceProof(agentA.did, chain()),
      chainHash: `sha256:${"0".repeat(64)}`,
    };
    const verification = await verify(proof);
    expect(verification.valid).toBe(false);
    expect(
      verification.conditions.find((c) => c.condition === 2)?.detail,
    ).toContain("does not match computed");
  });

  it("evaluates every condition, so all problems surface at once", async () => {
    const proof = buildProvenanceProof(agentB.did, chain());
    const verification = await verify(proof, { keyPossessionProved: false });
    expect(verification.conditions).toHaveLength(9);
    expect(failed(verification).length).toBeGreaterThan(1);
  });

  it("never lets a condition pass vacuously on a malformed chain", async () => {
    // The most dangerous kind of green: a check that passed because it could not
    // run.
    for (const credentials of [[], [edge("acc-1", human, agentA)], [root(), root()]]) {
      const verification = await verify(
        buildProvenanceProof(agentA.did, credentials as SignedCredential[]),
      );
      expect(verification.valid).toBe(false);
      expect(verification.conditions.every((c) => !c.passed)).toBe(true);
      expect(verification.conditions.every((c) => c.detail.startsWith("not evaluated"))).toBe(
        true,
      );
    }
  });

  it("produces actionable findings, not bare failures", async () => {
    const verification = await verify(buildProvenanceProof(agentA.did, chain()), {
      keyPossessionProved: false,
    });
    expect(verification.findings).toHaveLength(1);
    const finding = verification.findings[0];
    expect(finding?.code).toBe("PROVENANCE_CONDITION_8");
    expect(finding?.component).toBe("provenance");
    expect(finding?.remediation).toContain("challenge");
  });

  it("orders the chain hash, so reordering changes it", async () => {
    const forward = computeChainHash(chain());
    const reversed = computeChainHash([...chain()].reverse());
    expect(forward).not.toBe(reversed);
  });
});

describe("key possession challenge", () => {
  it("verifies a correct response", () => {
    const challenge = createChallenge({
      subjectDid: agentA.did,
      runId: "run-1",
      issuedAt: T0,
      nonce: "fixed-nonce",
    });
    const response = respondToChallenge(challenge, agentA.privateKey);
    expect(verifyChallengeResponse(challenge, response, T0).proved).toBe(true);
  });

  it("rejects a response signed by the wrong key", () => {
    const challenge = createChallenge({
      subjectDid: agentA.did,
      runId: "run-1",
      issuedAt: T0,
      nonce: "n",
    });
    const response = respondToChallenge(challenge, agentB.privateKey);
    expect(verifyChallengeResponse(challenge, response, T0).proved).toBe(false);
  });

  it("rejects an expired challenge", () => {
    // A long-lived nonce is a replay window.
    const challenge = createChallenge({
      subjectDid: agentA.did,
      runId: "run-1",
      issuedAt: T0,
      nonce: "n",
      ttlMs: 1000,
    });
    const response = respondToChallenge(challenge, agentA.privateKey);
    const verification = verifyChallengeResponse(challenge, response, T1);
    expect(verification.proved).toBe(false);
    expect(verification.reason).toContain("replay window");
  });

  it("cannot be replayed into another run", () => {
    // runId is inside the signed payload.
    const forRunOne = createChallenge({
      subjectDid: agentA.did,
      runId: "run-1",
      issuedAt: T0,
      nonce: "n",
    });
    const response = respondToChallenge(forRunOne, agentA.privateKey);
    const forRunTwo = { ...forRunOne, runId: "run-2" };
    expect(verifyChallengeResponse(forRunTwo, response, T0).proved).toBe(false);
  });

  it("is single-use", () => {
    const registry = new ChallengeRegistry();
    const challenge = registry.issue(
      createChallenge({ subjectDid: agentA.did, runId: "run-1", issuedAt: T0, nonce: "n" }),
    );
    const response = respondToChallenge(challenge, agentA.privateKey);

    expect(registry.consume(response, T0).proved).toBe(true);
    const replay = registry.consume(response, T0);
    expect(replay.proved).toBe(false);
    expect(replay.reason).toContain("already have been used");
  });

  it("generates a distinct nonce each time", () => {
    const first = createChallenge({ subjectDid: agentA.did, runId: "r", issuedAt: T0 });
    const second = createChallenge({ subjectDid: agentA.did, runId: "r", issuedAt: T0 });
    expect(first.nonce).not.toBe(second.nonce);
  });
});

describe("revocation", () => {
  it("refuses an unsigned revocation", () => {
    // Anyone who could revoke without signing could silently strip authority.
    const registry = new RevocationRegistry();
    const unsigned = {
      credentialId: "acc-1",
      revokerDid: human.did,
      reasonCode: "other" as const,
      effectiveAt: T1,
      signature: "A".repeat(86),
    };
    expect(registry.revoke(unsigned)).toBe(false);
    expect(registry.statusAt("acc-1", T2).revoked).toBe(false);
  });

  it("verifies a signed revocation", () => {
    const revocation = signRevocation(
      {
        credentialId: "acc-1",
        revokerDid: human.did,
        reasonCode: "key_compromise",
        effectiveAt: T1,
      },
      human.privateKey,
    );
    expect(verifyRevocationSignature(revocation)).toBe(true);
    expect(new RevocationRegistry().revoke(revocation)).toBe(true);
  });

  it("answers status relative to a time, never in the present tense", () => {
    const registry = new RevocationRegistry();
    registry.revoke(
      signRevocation(
        {
          credentialId: "acc-1",
          revokerDid: human.did,
          reasonCode: "policy_violation",
          effectiveAt: T2,
        },
        human.privateKey,
      ),
    );
    expect(registry.statusAt("acc-1", T1).revoked).toBe(false);
    expect(registry.statusAt("acc-1", T3).revoked).toBe(true);
  });

  it("keeps the earliest effective revocation", () => {
    // A later revocation cannot un-revoke.
    const registry = new RevocationRegistry();
    for (const effectiveAt of [T2, T1]) {
      registry.revoke(
        signRevocation(
          {
            credentialId: "acc-1",
            revokerDid: human.did,
            reasonCode: "other",
            effectiveAt,
          },
          human.privateKey,
        ),
      );
    }
    expect(registry.statusAt("acc-1", T1).revoked).toBe(true);
  });
});

describe("blast radius", () => {
  const fullChain = (): readonly SignedCredential[] => [
    root(),
    edge("acc-1", human, agentA),
    edge("acc-2", agentA, agentB),
    edge("acc-3", agentB, agentC),
  ];

  it("shows what revoking a leaf edge breaks", () => {
    const radius = computeBlastRadius("acc-3", fullChain());
    expect(radius.affectedDids).toEqual([agentC.did]);
  });

  it("shows the cascade from revoking a mid-chain edge", () => {
    // An operator revoking needs to know they are about to suspend two agents.
    const radius = computeBlastRadius("acc-2", fullChain());
    expect(radius.affectedDids).toEqual([agentB.did, agentC.did].sort());
    expect(radius.explanation).toContain("descendant(s)");
  });

  it("shows the whole lineage from revoking the human root", () => {
    const radius = computeBlastRadius("hrc-1", fullChain());
    expect(radius.affectedDids).toHaveLength(4);
    expect(radius.humanRootsAffected).toEqual([human.did]);
  });

  it("reports nothing for an unknown credential rather than guessing", () => {
    const radius = computeBlastRadius("absent", fullChain());
    expect(radius.affectedDids).toEqual([]);
    expect(radius.explanation).toContain("not present");
  });

  it("terminates on a cyclic chain", () => {
    // A malformed chain must still yield an answer rather than hanging.
    const cyclic = [
      root(),
      edge("acc-1", agentA, agentB),
      edge("acc-2", agentB, agentA),
    ];
    const radius = computeBlastRadius("acc-1", cyclic);
    expect(radius.affectedDids.length).toBeGreaterThan(0);
  });
});

describe("lineage graph", () => {
  const credentials = (): readonly SignedCredential[] => [
    root(),
    edge("acc-1", human, agentA),
    edge("acc-2", human, agentB),
    edge("acc-3", agentA, agentC),
  ];

  it("records depth and parentage", () => {
    const graph = buildLineageGraph(credentials(), "run-1");
    expect(graph.nodes.get(agentA.did)?.depth).toBe(1);
    expect(graph.nodes.get(agentC.did)?.depth).toBe(2);
    expect(graph.nodes.get(agentC.did)?.parentDid).toBe(agentA.did);
  });

  it("counts fan-out per root, excluding the root itself", () => {
    const graph = buildLineageGraph(credentials(), "run-1");
    expect(graph.fanOutPerRoot.get(human.did)).toBe(3);
  });

  it("finds participants sharing a root", () => {
    const graph = buildLineageGraph(credentials(), "run-1");
    expect(sharesRootWith(graph, agentA.did)).toContain(agentB.did);
  });

  it("gives a stable pseudonym within a run and a different one across runs", () => {
    // §11.8 pseudonymity preserved, while still letting agents discover that they
    // share a root — which is what makes §49.7 and §49.8 distinguishable.
    expect(lineagePseudonym(human.did, "run-1")).toBe(lineagePseudonym(human.did, "run-1"));
    expect(lineagePseudonym(human.did, "run-1")).not.toBe(
      lineagePseudonym(human.did, "run-2"),
    );
  });

  it("discloses by visibility level, defaulting closed on an unknown level", () => {
    expect(describeLineage(human.did, "r", "exact").root).toBe(human.did);
    expect(describeLineage(human.did, "r", "hashed").root).toBeUndefined();
    expect(describeLineage(human.did, "r", "hashed").pseudonym).toBeDefined();
    expect(describeLineage(human.did, "r", "counts_only")).toEqual({});
    expect(describeLineage(human.did, "r", "future_level" as never)).toEqual({});
  });
});

describe("M2 acceptance criteria", () => {
  const service = () =>
    new AdmissionService({
      runId: "run-m2",
      resolvers: defaultResolvers(),
      revocations: new RevocationRegistry(),
    });

  it("a human creates Agent A, A creates B, and B proves the path", async () => {
    const humanRoot = root();
    const humanToA = edge("acc-1", human, agentA, { redelegable: true });
    const aToB = edge("acc-2", agentA, agentB);

    const admissions = service();

    // The human is admitted on their own root.
    const humanOutcome = await admissions.admit(
      buildProvenanceProof(human.did, [humanRoot]),
      { at: T2, keyPossessionProved: true },
    );
    expect(humanOutcome.admitted).toBe(true);

    // Agent A proves one edge.
    const aOutcome = await admissions.admit(
      buildProvenanceProof(agentA.did, [humanToA, humanRoot]),
      { at: T2, keyPossessionProved: true },
    );
    expect(aOutcome.admitted).toBe(true);
    if (aOutcome.admitted) expect(aOutcome.lineageDepth).toBe(1);

    // Agent B proves the full path back to the human.
    const bOutcome = await admissions.admit(
      buildProvenanceProof(agentB.did, [aToB, humanToA, humanRoot]),
      { at: T2, keyPossessionProved: true },
    );
    expect(bOutcome.admitted).toBe(true);
    if (bOutcome.admitted) {
      expect(bOutcome.lineageDepth).toBe(2);
      expect(bOutcome.terminalHumanDids).toEqual([human.did]);
      expect(bOutcome.provenancePathHashes).toHaveLength(3);
    }
  });

  it("an invalid edge is rejected", async () => {
    // agentC signs a credential claiming agentB as its parent.
    const forged = issueAgentCreationCredential({
      id: "acc-forged",
      parentDid: agentB.did,
      childDid: agentC.did,
      parentPrivateKey: agentC.privateKey,
      relationship: "created",
      issuedAt: T1,
    });
    const outcome = await service().admit(
      buildProvenanceProof(agentC.did, [forged, edge("acc-1", human, agentA), root()]),
      { at: T2, keyPossessionProved: true },
    );
    expect(outcome.admitted).toBe(false);
    if (!outcome.admitted) expect(outcome.reason).toBe("provenance_invalid");
  });

  it("root revocation suspends descendants", async () => {
    const revocations = new RevocationRegistry();
    const admissions = new AdmissionService({
      runId: "run-m2-revoke",
      resolvers: defaultResolvers(),
      revocations,
    });

    const humanRoot = root();
    const humanToA = edge("acc-1", human, agentA, { redelegable: true });
    const aToB = edge("acc-2", agentA, agentB);

    await admissions.admit(buildProvenanceProof(human.did, [humanRoot]), {
      at: T1,
      keyPossessionProved: true,
    });
    await admissions.admit(buildProvenanceProof(agentA.did, [humanToA, humanRoot]), {
      at: T1,
      keyPossessionProved: true,
    });
    await admissions.admit(
      buildProvenanceProof(agentB.did, [aToB, humanToA, humanRoot]),
      { at: T1, keyPossessionProved: true },
    );
    expect(admissions.admittedCount).toBe(3);

    // See the damage before doing it.
    const radius = computeBlastRadius("hrc-1", admissions.credentials);
    expect(radius.affectedDids).toHaveLength(3);

    revocations.revoke(
      signRevocation(
        {
          credentialId: "hrc-1",
          revokerDid: controller.did,
          reasonCode: "key_compromise",
          effectiveAt: T2,
        },
        controller.privateKey,
      ),
    );

    const suspended = admissions.suspendAffectedBy("hrc-1");
    expect(suspended).toHaveLength(3);
    expect(admissions.lookup(agentB.did)).toBeUndefined();
    expect(admissions.isSuspended(agentB.did)).toBe(true);
  });

  it("refuses a second admission for the same DID", async () => {
    const admissions = service();
    const proof = buildProvenanceProof(human.did, [root()]);
    await admissions.admit(proof, { at: T2, keyPossessionProved: true });
    const again = await admissions.admit(proof, { at: T2, keyPossessionProved: true });
    expect(again.admitted).toBe(false);
    if (!again.admitted) expect(again.reason).toBe("already_admitted");
  });

  it("names the most specific rejection reason available", async () => {
    // "Provenance invalid" is true but unhelpful when the real problem is the
    // fan-out ceiling.
    const admissions = new AdmissionService({
      runId: "run-fanout",
      resolvers: defaultResolvers(),
      revocations: new RevocationRegistry(),
      constraints: { maxDepth: 4, maxFanOutPerRoot: 1 },
    });
    const humanRoot = root();
    await admissions.admit(
      buildProvenanceProof(agentA.did, [edge("acc-1", human, agentA), humanRoot]),
      { at: T2, keyPossessionProved: true },
    );
    const second = await admissions.admit(
      buildProvenanceProof(agentB.did, [edge("acc-2", human, agentB), humanRoot]),
      { at: T2, keyPossessionProved: true },
    );
    expect(second.admitted).toBe(false);
    if (!second.admitted) expect(second.reason).toBe("fan_out_exceeded");
  });

  it("refuses admission without proved key possession", async () => {
    const outcome = await service().admit(buildProvenanceProof(human.did, [root()]), {
      at: T2,
      keyPossessionProved: false,
    });
    expect(outcome.admitted).toBe(false);
    if (!outcome.admitted) expect(outcome.reason).toBe("key_possession_failed");
  });

  it("issues a distinct admission credential per participant", async () => {
    const admissions = service();
    const humanRoot = root();
    const first = await admissions.admit(buildProvenanceProof(human.did, [humanRoot]), {
      at: T2,
      keyPossessionProved: true,
    });
    const second = await admissions.admit(
      buildProvenanceProof(agentA.did, [edge("acc-1", human, agentA), humanRoot]),
      { at: T2, keyPossessionProved: true },
    );
    expect(first.admitted && second.admitted).toBe(true);
    if (first.admitted && second.admitted) {
      expect(first.admissionCredentialId).not.toBe(second.admissionCredentialId);
    }
  });

  it("works with freshly generated keys, not only deterministic ones", async () => {
    const freshHuman = generateKeyPair();
    const freshAgent = generateKeyPair();
    const freshRoot = issueHumanRootCredential({
      id: "hrc-fresh",
      subjectDid: freshHuman.did,
      issuerDid: controller.did,
      issuerPrivateKey: controller.privateKey,
      verificationMethod: "trusted_invitation",
      issuedAt: T0,
    });
    const freshEdge = issueAgentCreationCredential({
      id: "acc-fresh",
      parentDid: freshHuman.did,
      childDid: freshAgent.did,
      parentPrivateKey: freshHuman.privateKey,
      relationship: "commissioned",
      issuedAt: T1,
    });
    const outcome = await service().admit(
      buildProvenanceProof(freshAgent.did, [freshEdge, freshRoot]),
      { at: T2, keyPossessionProved: true },
    );
    expect(outcome.admitted).toBe(true);
  });
});
