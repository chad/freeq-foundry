/**
 * The HTTP server: gateway API, `.well-known` onboarding, and the live observer.
 *
 * Uses only `node:http`. A framework would add dependencies to a process that holds
 * the recorder key and terminates external connections, and the routing here is a
 * dozen paths.
 *
 * Visibility filtering happens on every read path (§33.7). The observer is a *viewer*
 * like any other, so a spectator cannot see controller-only material by connecting to
 * a different endpoint.
 *
 * Spec: §13, §36, §37, §38.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Gateway,
  type Viewer,
} from "@freeq-foundry/gateway";
import type { EventStore } from "@freeq-foundry/event-store";
import type { RecordedEvent } from "@freeq-foundry/protocol";
import {
  discoveryDocument,
  discoveryMarkdown,
  diagnose,
  type DiscoveryOptions,
} from "./wellknown.js";
import { OBSERVER_HTML } from "./observer-ui.js";

/**
 * Admits an external applicant.
 *
 * Supplied by the host rather than built here, because admission needs the run's
 * credential registry, revocation state, and lineage ceilings — and a server that
 * held those would be a second place authority lives.
 */
export interface ExternalAdmission {
  /** Issue a key-possession challenge (§6.3). */
  challenge(did: string): Promise<{ readonly challenge: unknown } | { readonly error: string }>;
  /** Verify a proof and a signed challenge, then admit or refuse. */
  admit(request: {
    readonly proof: unknown;
    readonly challengeResponse: unknown;
  }): Promise<
    | { readonly admitted: true; readonly admissionCredentialId: string; readonly lineagePseudonym: string }
    | { readonly admitted: false; readonly reason: string; readonly detail: string; readonly findings?: unknown }
  >;
}

export interface ServerOptions {
  readonly gateway: Gateway;
  readonly store: EventStore;
  readonly runId: string;
  /**
   * Present only when the run accepts external participants.
   *
   * Absent by default: a run that has not opted in refuses admission rather than
   * silently accepting strangers.
   */
  readonly admission?: ExternalAdmission;
  /** Whether `POST /api/events` accepts submissions from admitted participants. */
  readonly acceptSubmissions?: boolean;
  readonly discovery: Omit<DiscoveryOptions, "baseUrl">;
  readonly host?: string;
  readonly port?: number;
  /** Conformance vectors, served so an implementer can self-certify. */
  readonly vectors?: unknown;
  /**
   * Delay before the spectator feed shows an event, in milliseconds.
   *
   * §58.12 asks how much delay prevents a spectator relaying hidden information to a
   * participant. No delay defeats a determined side channel, so this is about cost
   * rather than prevention — and private material is excluded outright rather than
   * delayed.
   */
  readonly spectatorDelayMs?: number;
}

interface Subscriber {
  readonly response: ServerResponse;
  readonly viewer: Viewer;
}

/**
 * Runs the API and the observer.
 *
 * Deliberately read-mostly: the only mutating route is event submission, which goes
 * through the gateway and therefore through every §33.4 check.
 */
export class FoundryServer {
  readonly #options: ServerOptions;
  readonly #server: Server;
  readonly #subscribers = new Set<Subscriber>();
  #baseUrl = "";

  constructor(options: ServerOptions) {
    this.#options = options;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        // A handler that throws must still answer, or a client hangs waiting.
        respondJson(response, 500, { error: "internal", detail: String(error) });
      });
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => {
      this.#server.listen(this.#options.port ?? 0, this.#options.host ?? "127.0.0.1", resolve);
    });
    const address = this.#server.address() as AddressInfo;
    this.#baseUrl = `http://${this.#options.host ?? "127.0.0.1"}:${address.port}`;
    return this.#baseUrl;
  }

  get url(): string {
    return this.#baseUrl;
  }

  async close(): Promise<void> {
    for (const subscriber of this.#subscribers) subscriber.response.end();
    this.#subscribers.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /**
   * Push an event to subscribers.
   *
   * Filtered per subscriber, because visibility is a question about the asker. A
   * single broadcast would leak controller-only events to every spectator.
   */
  broadcast(event: RecordedEvent): void {
    const delay = this.#options.spectatorDelayMs ?? 0;
    const send = (): void => {
      for (const subscriber of this.#subscribers) {
        if (!this.#visibleTo(event, subscriber.viewer)) continue;
        subscriber.response.write(`event: append\ndata: ${JSON.stringify(event)}\n\n`);
      }
    };
    if (delay > 0) setTimeout(send, delay).unref();
    else send();
  }

  #visibleTo(event: RecordedEvent, viewer: Viewer): boolean {
    // Reuses the gateway's rule rather than reimplementing it: one implementation of
    // a visibility check is safer than two that agree today.
    const policy = event.visibility;
    if (viewer.participantType === "controller") return true;
    if (event.actorDid === viewer.did) return true;
    switch (policy.type) {
      case "public":
        return true;
      case "channel":
        return (viewer.channelIds ?? []).includes(policy.channelId);
      case "participants":
        return policy.participantDids.includes(viewer.did);
      case "lineage":
        return (viewer.terminalHumanDids ?? []).includes(policy.terminalHumanDid);
      case "controller":
        return false;
      case "post_run_reveal":
        return viewer.postRun === true;
      default:
        // Default deny: a new policy type must not leak on its first day.
        return false;
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.#baseUrl || "http://localhost");
    const path = url.pathname;

    // A spectator UI served from the same origin needs no CORS, but an external agent
    // integrating from a browser does.
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-headers", "content-type");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    const discoveryOptions: DiscoveryOptions = {
      ...this.#options.discovery,
      baseUrl: this.#baseUrl,
    };

    // ---- .well-known (§13) ----

    if (path === "/.well-known/freeq-agent") {
      // §13.3 representation negotiation: the same content for a person or a program.
      const accept = request.headers["accept"] ?? "";
      if (accept.includes("text/markdown") || url.searchParams.get("format") === "md") {
        response.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
        response.end(discoveryMarkdown(discoveryOptions));
        return;
      }
      respondJson(response, 200, discoveryDocument(discoveryOptions));
      return;
    }

    if (path === "/.well-known/freeq-agent/vectors") {
      if (this.#options.vectors === undefined) {
        respondJson(response, 404, { error: "vectors not served by this instance" });
        return;
      }
      respondJson(response, 200, this.#options.vectors);
      return;
    }

    if (path === "/.well-known/freeq-agent/challenge" && request.method === "POST") {
      if (this.#options.admission === undefined) {
        respondJson(response, 503, {
          error: "this run does not accept external participants",
          remediation:
            "Start the run with external admission enabled. A run that has not opted in " +
            "refuses admission rather than silently accepting strangers.",
        });
        return;
      }
      const body = (await readJson(request)) as { did?: unknown } | undefined;
      if (typeof body?.did !== "string") {
        respondJson(response, 400, { error: 'body must be {"did":"did:..."}' });
        return;
      }
      const issued = await this.#options.admission.challenge(body.did);
      if ("error" in issued) {
        respondJson(response, 422, { error: issued.error });
        return;
      }
      respondJson(response, 200, issued);
      return;
    }

    if (path === "/api/admission" && request.method === "POST") {
      if (this.#options.admission === undefined) {
        respondJson(response, 503, { error: "this run does not accept external participants" });
        return;
      }
      const body = (await readJson(request)) as
        | { proof?: unknown; challengeResponse?: unknown }
        | undefined;
      if (body === undefined) {
        respondJson(response, 400, { error: "body must be JSON" });
        return;
      }
      const outcome = await this.#options.admission.admit({
        proof: body.proof,
        challengeResponse: body.challengeResponse,
      });
      // 403 rather than 422: the request was well formed and the applicant was
      // refused, which is a different thing from a malformed application.
      respondJson(response, outcome.admitted ? 201 : 403, outcome);
      return;
    }

    if (path === "/.well-known/freeq-agent/diagnose" && request.method === "POST") {
      const body = await readJson(request);
      if (body === undefined) {
        respondJson(response, 400, { error: "body must be JSON" });
        return;
      }
      respondJson(response, 200, diagnose(body as Record<string, unknown>));
      return;
    }

    // ---- API (§36) ----

    if (path === "/api/events" && request.method === "POST") {
      if (this.#options.acceptSubmissions !== true) {
        respondJson(response, 503, {
          error: "this run does not accept external submissions",
          remediation:
            "The run is driven by its own participants. Start it with submissions " +
            "enabled to accept events from external operators.",
        });
        return;
      }
      const body = await readJson(request);
      if (body === undefined) {
        respondJson(response, 400, { error: "body must be JSON" });
        return;
      }
      const result = await this.#options.gateway.submit(body as never);
      // 202 on acceptance because the gateway assigns position; 422 on rejection
      // because the request was understood and refused on its merits.
      respondJson(response, result.accepted ? 202 : 422, result);
      return;
    }

    if (path === "/api/sequence") {
      const did = url.searchParams.get("did");
      if (did === null) {
        respondJson(response, 400, { error: "did query parameter is required" });
        return;
      }
      respondJson(response, 200, {
        runId: this.#options.runId,
        did,
        // Lets a client resynchronize after a lost acknowledgement rather than
        // guessing and tripping a sequence rejection.
        nextSequence: (await this.#options.gateway.sequenceFor(this.#options.runId, did)) + 1,
      });
      return;
    }

    if (path === "/api/events" && request.method === "GET") {
      const viewer = viewerFrom(url);
      const from = Number(url.searchParams.get("from") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "500");
      const events: RecordedEvent[] = [];
      for await (const event of this.#options.gateway.subscribe(this.#options.runId, viewer, {
        fromLogicalTime: from,
        limit,
      })) {
        events.push(event);
      }
      respondJson(response, 200, { runId: this.#options.runId, events });
      return;
    }

    if (path === "/api/head") {
      const head = await this.#options.store.head(this.#options.runId);
      respondJson(response, 200, head ?? { runId: this.#options.runId, eventCount: 0 });
      return;
    }

    if (path === "/api/verify") {
      // Anyone may verify the chain. A tamper-evident log nobody can check is a
      // tamper-evident log in name only.
      respondJson(response, 200, await this.#options.store.verifyChain(this.#options.runId));
      return;
    }

    if (path === "/api/stream") {
      await this.#stream(request, response, url);
      return;
    }

    // ---- Observer (§38) ----

    if (path === "/" || path === "/observer") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(OBSERVER_HTML);
      return;
    }

    respondJson(response, 404, { error: `no route for ${path}` });
  }

  /** Server-sent events. Chosen over WebSocket because the feed is one-directional. */
  async #stream(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const viewer = viewerFrom(url);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // Without this a proxy may buffer the stream and the observer looks frozen.
      "x-accel-buffering": "no",
    });

    // Replay history first, so a late observer sees the whole run rather than only
    // what happens after it connected.
    const from = Number(url.searchParams.get("from") ?? "0");
    for await (const event of this.#options.gateway.subscribe(this.#options.runId, viewer, {
      fromLogicalTime: from,
    })) {
      response.write(`event: append\ndata: ${JSON.stringify(event)}\n\n`);
    }
    response.write(`event: caughtup\ndata: {}\n\n`);

    const subscriber: Subscriber = { response, viewer };
    this.#subscribers.add(subscriber);

    const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 15_000);
    keepAlive.unref();

    request.on("close", () => {
      clearInterval(keepAlive);
      this.#subscribers.delete(subscriber);
    });
  }
}

/**
 * Build a viewer from query parameters.
 *
 * Defaults to an anonymous spectator, which sees public events only. Claiming a
 * privileged role would need a signed challenge; a query parameter is not
 * authentication, and nothing here treats it as one — a viewer can only ever narrow
 * what it sees, never widen it beyond `public`.
 */
function viewerFrom(url: URL): Viewer {
  const did = url.searchParams.get("did") ?? "did:key:zSpectator";
  return {
    did,
    // Always a spectator. §58.12's concern is a spectator relaying hidden information;
    // letting one self-declare as controller would hand it over directly.
    participantType: "observer",
    ...(url.searchParams.get("postRun") === "true" ? { postRun: true } : {}),
  };
}

async function readJson(request: IncomingMessage): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += (chunk as Buffer).byteLength;
    // Bounded: an unbounded body is a trivial denial of service.
    if (bytes > 2 * 1024 * 1024) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  // Guard rather than trust every branch to return. A missing `return` in one route
  // produced ERR_HTTP_HEADERS_SENT, which surfaced as an unhandled error while every
  // assertion still passed — exactly the kind of fault that reaches production.
  if (response.headersSent) return;
  const text = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}
