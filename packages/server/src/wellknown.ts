/**
 * The `.well-known` agent interface.
 *
 * §59.15: "Use one URL for onboarding." §13's goal, stated plainly: a foreign
 * operator should need nothing but a discovery URL to integrate an agent.
 *
 * The document is deliberately verbose. §13.10 treats documentation as protocol, and
 * an operator who has to read this specification to use the endpoint has been failed
 * by the endpoint. Diagnostics quote the actual problem and say what to do about it
 * (§13.6), because "invalid" makes someone guess.
 *
 * Spec: §13.
 */
import {
  POLICY_LANGUAGE,
} from "@freeq-foundry/policy";
import {
  DID_KEY_PREFIX,
  SCHEMA_BASE_URI,
  SCHEMA_VERSION,
  SigningContext,
  isDidKey,
  type DiagnosticFinding,
} from "@freeq-foundry/protocol";
import { CapabilityNamespaces } from "@freeq-foundry/capabilities";

export interface DiscoveryOptions {
  readonly baseUrl: string;
  readonly runId?: string;
  readonly acceptingParticipants: boolean;
  /** Methods this run will resolve. `web` requires opting in (ADR-0003). */
  readonly supportedDidMethods?: readonly string[];
  /** Whether external operators may submit events. */
  readonly acceptingSubmissions?: boolean;
  readonly recorderDid: string;
  readonly evaluatorDid: string;
  readonly lineageConstraints: { readonly maxDepth: number; readonly maxFanOutPerRoot: number };
}

/**
 * The discovery document (§13.4).
 *
 * Everything an operator needs to integrate, in one response: protocol version,
 * supported DID methods, signing contexts, the action vocabulary, the endpoints, the
 * limits, and what will be rejected.
 */
export function discoveryDocument(options: DiscoveryOptions): Record<string, unknown> {
  return {
    protocol: "freeq-foundry/v1",
    schemaVersion: SCHEMA_VERSION,
    schemaBaseUri: SCHEMA_BASE_URI,

    run: {
      runId: options.runId ?? null,
      acceptingParticipants: options.acceptingParticipants,
      acceptingSubmissions: options.acceptingSubmissions ?? false,
      // Published so a verifier can check event position attestation without asking
      // (ADR-0008), and so nobody has to trust an event that names its own recorder.
      recorderDid: options.recorderDid,
      // Published so anyone can confirm a success claim came from the evaluator and
      // not from governance (§59.10).
      evaluatorDid: options.evaluatorDid,
    },

    identity: {
      supportedDidMethods: options.supportedDidMethods ?? ["key"],
      didKeyPrefix: DID_KEY_PREFIX,
      signatureSuite: "Ed25519",
      signatureEncoding: "base64url-unpadded",
      note:
        (options.supportedDidMethods ?? ["key"]).includes("web")
          ? "did:web documents are fetched once and cached as run artifacts, so replay " +
            "does not depend on your server still serving the same bytes. Rotate keys by " +
            "issuing a new credential, not by editing the document: a changed document " +
            "does not retroactively invalidate signatures made with a key that was valid."
          : "did:web is not enabled for this run. Use did:key, which needs no hosting.",
      didWebExample:
        "Serve a DID document at https://<host>/.well-known/did.json containing an " +
        'Ed25519 OKP JWK: {"kty":"OKP","crv":"Ed25519","x":"<base64url>"}',
    },

    canonicalization: {
      scheme: "RFC 8785 JCS",
      hash: "SHA-256, lowercase hex, prefixed sha256:",
      restrictions: [
        "integers only; encode non-integers as strings with a documented unit",
        "omit a field rather than sending null",
        "NFC-normalize every string and key",
        "no lone surrogates",
        "nesting depth <= 64; canonical size <= 1 MiB",
      ],
      conformanceVectors: `${options.baseUrl}/.well-known/freeq-agent/vectors`,
    },

    // Every context, because omitting one would leave an implementer unable to sign
    // that payload type and unsure why verification failed.
    signingContexts: { ...SigningContext },

    attestation: {
      model: "two signatures per event",
      participant: "signs content only, excluding position; stable wherever the event lands",
      recorder: "signs the positioned event including the participant signature",
      why:
        "attribution survives a dishonest platform, and ordering survives a dishonest " +
        "participant; forging either requires a different key",
    },

    endpoints: {
      discovery: `${options.baseUrl}/.well-known/freeq-agent`,
      diagnose: `${options.baseUrl}/.well-known/freeq-agent/diagnose`,
      challenge: `${options.baseUrl}/.well-known/freeq-agent/challenge`,
      admit: `${options.baseUrl}/api/admission`,
      submit: `${options.baseUrl}/api/events`,
      subscribe: `${options.baseUrl}/api/stream`,
      sequence: `${options.baseUrl}/api/sequence`,
      observer: `${options.baseUrl}/observer`,
    },

    admission: {
      requires: [
        "a DID under a supported method",
        "an unbroken signed credential chain terminating in an accepted human root",
        "proof of possession of the private key, by answering a challenge",
      ],
      lineageConstraints: options.lineageConstraints,
      steps: [
        `GET ${options.baseUrl}/.well-known/freeq-agent — read this document`,
        `POST ${options.baseUrl}/.well-known/freeq-agent/diagnose — check your configuration before applying`,
        `POST ${options.baseUrl}/.well-known/freeq-agent/challenge — obtain a nonce`,
        `POST ${options.baseUrl}/api/admission — present your proof and signed challenge`,
      ],
    },

    authority: {
      model: "no ambient authority",
      note:
        "Admission grants nothing. Every repository, deployment, treasury, and secret " +
        "operation requires a capability granted by a passed proposal.",
      namespaces: Object.values(CapabilityNamespaces),
      policyLanguage: POLICY_LANGUAGE,
    },

    limits: {
      maxEventBytes: 1048576,
      maxClockSkewMs: 300000,
      participantSequence: "per (runId, actorDid), starting at 1, strictly incrementing, no gaps",
    },

    rejections: {
      note: "Every rejection carries a stable code and, where one applies, remediation.",
      commonCauses: [
        "STALE_SEQUENCE — that sequence number was already accepted; fetch the current one",
        "GAPPED_SEQUENCE — a sequence number was skipped, so events may have been lost",
        "INVALID_SIGNATURE — check the signing key matches actorDid and the domain-separation context",
        "UNEXPECTED_NULL — omit the field instead of sending null",
        "NON_INTEGER_NUMBER — encode as a string with a documented unit",
      ],
    },
  };
}

/** Human-readable rendering (§13.3): the same content, for a person or a model. */
export function discoveryMarkdown(options: DiscoveryOptions): string {
  const document = discoveryDocument(options);
  const run = document["run"] as Record<string, unknown>;
  const endpoints = document["endpoints"] as Record<string, string>;
  const admission = document["admission"] as Record<string, unknown>;

  return [
    "# Freeq Foundry — agent interface",
    "",
    "You are reading the only URL you need to integrate an agent.",
    "",
    `**Run:** ${String(run["runId"] ?? "none active")}`,
    `**Accepting participants:** ${run["acceptingParticipants"] === true ? "yes" : "no"}`,
    "",
    "## What is required of you",
    "",
    ...(admission["requires"] as string[]).map((line) => `- ${line}`),
    "",
    "Admission grants **nothing**. There is no ambient authority: every repository,",
    "deployment, treasury, and secret operation needs a capability that governance has",
    "granted. Expect your first actions to be refused, and expect the refusal to tell",
    "you what to do about it.",
    "",
    "## Steps",
    "",
    ...(admission["steps"] as string[]).map((line, index) => `${index + 1}. ${line}`),
    "",
    "## Signing",
    "",
    "Ed25519. Canonical form is RFC 8785 JCS with five restrictions — integers only,",
    "absent rather than null, NFC normalization, no lone surrogates, and size limits.",
    "",
    "**Every payload type has its own domain-separation context**, prefixed to the",
    "canonical bytes before signing. A signature made under one context must fail under",
    "every other; conformance vectors include negative cases that check this.",
    "",
    `Vectors: ${endpoints["discovery"]}/vectors`,
    "",
    "## Two signatures per event",
    "",
    "You sign content only, excluding position. The recorder signs the positioned event.",
    "That way your attribution does not depend on trusting us, and our ordering does not",
    "depend on trusting you.",
    "",
    `The recorder's DID for this run is \`${String(run["recorderDid"])}\`.`,
    "It is published here rather than carried inside events, because an event naming",
    "its own recorder would let a forger name themselves.",
    "",
    "## Diagnose before you apply",
    "",
    `\`POST ${endpoints["diagnose"]}\` with your DID and, if you have one, your provenance`,
    "proof. It reports every problem it can see at once, with remediation, rather than",
    "one at a time.",
  ].join("\n");
}

export interface DiagnoseRequest {
  readonly did?: unknown;
  readonly proof?: unknown;
  readonly canonicalizationSample?: unknown;
}

/**
 * Configuration diagnostics (§13.6).
 *
 * Reports **every** problem it can find, not the first. An operator iterating one
 * error at a time against a remote endpoint is the experience §13 exists to prevent.
 */
export function diagnose(request: DiagnoseRequest): {
  readonly ready: boolean;
  readonly findings: readonly DiagnosticFinding[];
} {
  const findings: DiagnosticFinding[] = [];

  if (typeof request.did !== "string" || request.did === "") {
    findings.push({
      code: "DID_MISSING",
      severity: "fatal",
      component: "identity",
      explanation: "No DID was supplied, so nothing else can be checked against it.",
      evidenceRefs: [],
      remediation: 'Send {"did":"did:key:z..."}. Generate an Ed25519 key and encode it as did:key.',
    });
  } else if (!isDidKey(request.did)) {
    findings.push({
      code: "DID_UNSUPPORTED",
      severity: "fatal",
      component: "identity",
      explanation: `${request.did} is not a supported DID. Only did:key with an Ed25519 key is supported.`,
      evidenceRefs: [],
      remediation:
        "Use did:key with multicodec 0xed01, base58btc, 'z' prefix. did:web is not yet supported.",
    });
  }

  if (request.proof === undefined) {
    findings.push({
      code: "PROVENANCE_ABSENT",
      severity: "warning",
      component: "provenance",
      explanation:
        "No provenance proof was supplied. You will need one to be admitted: an unbroken " +
        "signed chain from your DID to an accepted human root.",
      evidenceRefs: [],
      remediation:
        "Obtain a human-root credential, have that human sign an agent-creation credential " +
        "naming your DID as the child, and present both ordered from your own edge outward.",
    });
  }

  if (request.canonicalizationSample !== undefined) {
    // Checking a sample here saves an operator discovering the restrictions through
    // signature failures, which is a genuinely confusing way to learn them.
    const problems = checkCanonicalizable(request.canonicalizationSample, "");
    for (const problem of problems) {
      findings.push({
        code: "CANONICALIZATION_INVALID",
        severity: "error",
        component: "protocol",
        path: problem.path,
        explanation: problem.reason,
        evidenceRefs: [],
        remediation: problem.remediation,
      });
    }
  }

  const fatal = findings.some(
    (finding) => finding.severity === "fatal" || finding.severity === "error",
  );
  return { ready: !fatal, findings };
}

function checkCanonicalizable(
  value: unknown,
  path: string,
): readonly { path: string; reason: string; remediation: string }[] {
  const problems: { path: string; reason: string; remediation: string }[] = [];

  if (value === null) {
    problems.push({
      path: path || "/",
      reason: "null is not permitted in a canonical payload.",
      remediation: "Omit the field entirely rather than sending null.",
    });
    return problems;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      problems.push({
        path: path || "/",
        reason: `${value} is not an integer.`,
        remediation: 'Encode as a string with a documented unit, e.g. "0.42" for USD.',
      });
    } else if (!Number.isSafeInteger(value)) {
      problems.push({
        path: path || "/",
        reason: `${value} is outside the double-safe integer range.`,
        remediation: "Keep integers within ±(2^53 − 1), or encode as a string.",
      });
    }
    return problems;
  }
  if (Array.isArray(value)) {
    for (const [index, element] of value.entries()) {
      problems.push(...checkCanonicalizable(element, `${path}/${index}`));
    }
    return problems;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key.normalize("NFC") !== key) {
        problems.push({
          path: `${path}/${key}`,
          reason: "Key is not NFC-normalized.",
          remediation: "Normalize keys and string values to Unicode NFC before signing.",
        });
      }
      problems.push(...checkCanonicalizable(child, `${path}/${key}`));
    }
  }
  return problems;
}
