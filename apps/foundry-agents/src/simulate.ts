/**
 * A complete arena on localhost: no network, no keys, no cost.
 *
 * Developing an agent against a live arena is slow, costs money on every turn, and
 * makes you wait for eleven other participants to say something. This runs the *real*
 * registrar against a minimal freeq-compatible server with scripted opponents, so the
 * loop is instant and free. Point your agent at it and iterate.
 *
 *   foundry-agent simulate --port 7667
 *   python starters/python/agent.py --host localhost --port 7667 --no-tls --owner did:plc:x
 *
 * It also lints. Every mistake the starter agents made while being written — sending
 * coordination events as PRIVMSG, omitting the `at` timestamp, giving up after one join
 * announcement — is reported here with the fix, rather than manifesting as an agent that
 * mysteriously never joins.
 *
 * The server implements only what the protocol needs: CAP, SASL (accepted without
 * verification, because a local sandbox authenticating nobody is the point), NICK, USER,
 * JOIN, PRIVMSG, TAGMSG, PING. It is not an IRC server; it is enough of one.
 */
import { createHash } from "node:crypto";
import { createServer as createTcpServer, type Socket } from "node:net";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";

interface Client {
  readonly id: number;
  nick: string;
  did: string;
  registered: boolean;
  readonly channels: Set<string>;
  send(line: string): void;
  /** Set for the agent under test, so its behaviour can be linted. */
  lint: boolean;
}

export interface SimulateOptions {
  readonly port: number;
  readonly channel: string;
  readonly opponents: number;
  readonly quiet: boolean;
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Findings about a connected agent's protocol behaviour. */
class Linter {
  readonly #seen = new Map<string, number>();
  readonly #quiet: boolean;
  joinAnnouncements = 0;

  constructor(quiet: boolean) {
    this.#quiet = quiet;
  }

  report(code: string, detail: string): void {
    const count = (this.#seen.get(code) ?? 0) + 1;
    this.#seen.set(code, count);
    // Say it once with the fix; after that it is noise.
    if (count === 1 && !this.#quiet) console.log(`  ⚠ ${code}: ${detail}`);
  }

  inspect(line: string): void {
    const tagged = line.startsWith("@");
    const tags = tagged ? line.slice(1, line.indexOf(" ")) : "";
    const command = (tagged ? line.slice(line.indexOf(" ") + 1) : line).split(" ")[0] ?? "";
    const isEvent = tags.includes("+freeq.at/event");

    if (isEvent && command === "PRIVMSG") {
      this.report(
        "event-as-privmsg",
        "coordination events should be TAGMSG. A PRIVMSG renders in clients as a card containing the bare event name.",
      );
    }
    if (isEvent && !tags.includes("msgid=")) {
      this.report("no-msgid", "include a msgid tag so receivers can deduplicate.");
    }
    if (isEvent) {
      const payload = /\+freeq\.at\/payload=([^;\s]*)/.exec(tags)?.[1] ?? "";
      const eventType = /\+freeq\.at\/event=([^;\s]*)/.exec(tags)?.[1] ?? "";
      if (payload.includes("\\")) {
        this.report(
          "backslash-on-wire",
          "percent-encode backslashes (%5C). IRC tag unescaping mangles them and your JSON will not parse.",
        );
      }
      if (line.length > 4000) {
        this.report("oversized-tag", `line is ${line.length} bytes; tags are capped near 4094. Split into foundry_chunk events.`);
      }
      const stateChanging = ["foundry_join", "foundry_proposal", "foundry_vote", "foundry_declare", "foundry_file_put", "foundry_work_submitted"];
      if (stateChanging.includes(eventType) && !payload.includes("%22at%22") && !payload.includes('"at"')) {
        this.report("missing-at", `${eventType} needs an ISO "at" timestamp; the server replays history and undated events are ignored.`);
      }
      if (eventType === "foundry_join") this.joinAnnouncements++;
    }
  }

  summary(): string[] {
    const out: string[] = [];
    // Announcing once and stopping is correct once admitted, so a single announcement
    // is not a finding. Only silence is.
    if (this.joinAnnouncements === 0) {
      out.push("never sent foundry_join — the arena cannot admit an agent that does not ask");
    }
    for (const [code, count] of this.#seen) out.push(`${code} (${count}×)`);
    return out;
  }
}

/** A minimal freeq-compatible server: exactly enough for the arena protocol. */
export class MiniFreeq {
  readonly #clients = new Map<number, Client>();
  readonly #linter: Linter;
  #nextId = 1;
  readonly #options: SimulateOptions;

  constructor(options: SimulateOptions, linter: Linter) {
    this.#options = options;
    this.#linter = linter;
  }

  get linter(): Linter {
    return this.#linter;
  }

  /** Inject a line as if a client sent it. Used by scripted opponents. */
  injectFrom(client: Client, line: string): void {
    this.#handle(client, line);
  }

  addVirtualClient(nick: string, did: string): Client {
    const client: Client = {
      id: this.#nextId++,
      nick,
      did,
      registered: true,
      channels: new Set(),
      send: () => undefined,
      lint: false,
    };
    this.#clients.set(client.id, client);
    return client;
  }

  listen(): void {
    // Plain TCP, for clients that speak IRC directly (the Python starter).
    createTcpServer((socket: Socket) => {
      const client = this.#accept((line) => socket.write(`${line}\r\n`));
      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString("utf8");
        while (buffer.includes("\r\n")) {
          const index = buffer.indexOf("\r\n");
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (line === "") continue;
          try {
            this.#handle(client, line);
          } catch (error) {
            if (process.env["SIM_DEBUG"] === "1") console.log(`  !! ${String(error).slice(0, 100)}`);
          }
        }
      });
      socket.on("close", () => this.#clients.delete(client.id));
      socket.on("error", () => this.#clients.delete(client.id));
    }).listen(this.#options.port);

    // WebSocket, for bot-kit clients (the reference agents and the registrar itself).
    createHttpServer((request, response) => {
      if (process.env["SIM_DEBUG"] === "1") console.log(`  http ${request.method} ${request.url}`);
      response.writeHead(426);
      response.end("upgrade required");
    })
      .on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
        if (process.env["SIM_DEBUG"] === "1") {
          console.log(`  upgrade ${request.url} proto=${String(request.headers["sec-websocket-protocol"])}`);
        }
        const key = request.headers["sec-websocket-key"];
        const accept = createHash("sha1").update(`${String(key)}${WS_GUID}`).digest("base64");
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
            `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        const client = this.#accept((line) => {
          if (!socket.destroyed) socket.write(encodeFrame(`${line}\r\n`));
        });
        // Node may hand over bytes that arrived with the upgrade request. Dropping them
        // loses the client's first frame, which is where every IRC client puts its
        // registration burst.
        let buffer = head !== undefined && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
        let pending = "";
        const drain = (): void => {
          for (;;) {
            const frame = decodeFrame(buffer);
            if (process.env["SIM_DEBUG"] === "1") {
              console.log(`  frame: ${frame === null ? `null (buffered ${buffer.length})` : `op=${frame.opcode} len=${frame.payload.length} "${frame.payload.slice(0, 40).replace(/\r?\n/g, "|")}"`}`);
            }
            if (frame === null) break;
            buffer = buffer.subarray(frame.consumed);
            if (frame.opcode === 0x8) {
              socket.end();
              return;
            }
            // Control frames are not text. Treating a ping as IRC input injects binary
            // into the line parser and takes the connection down.
            if (frame.opcode === 0x9) {
              socket.write(Buffer.from([0x8a, 0x00]));
              continue;
            }
            if (frame.opcode === 0xa) continue;
            // A frame boundary is a message boundary here: the SDK sends each IRC line
            // as its own frame with no trailing newline, while the server sends lines
            // terminated by CRLF. Waiting for a newline that never arrives means the
            // registration burst is received, decoded, and then silently ignored.
            for (const line of (pending + frame.payload).split(/\r?\n/)) {
              if (line === "") continue;
              try {
                this.#handle(client, line);
              } catch (error) {
                // One malformed line must not end the session.
                if (process.env["SIM_DEBUG"] === "1") console.log(`  !! ${String(error).slice(0, 100)}`);
              }
            }
            pending = "";
          }
        };
        drain();
        socket.on("data", (data) => {
          if (process.env["SIM_DEBUG"] === "1") console.log(`  ws bytes: ${data.length}`);
          buffer = Buffer.concat([buffer, data]);
          drain();
        });
        socket.on("error", (error) => {
          if (process.env["SIM_DEBUG"] === "1") console.log(`  ws error: ${String(error).slice(0, 80)}`);
        });
        socket.on("close", () => this.#clients.delete(client.id));
        socket.on("error", () => this.#clients.delete(client.id));
      })
      .listen(this.#options.port + 1);
  }

  #accept(send: (line: string) => void): Client {
    const client: Client = {
      id: this.#nextId++,
      nick: `guest${this.#nextId}`,
      did: "",
      registered: false,
      channels: new Set(),
      send,
      lint: false,
    };
    this.#clients.set(client.id, client);
    return client;
  }

  #handle(client: Client, line: string): void {
    if (client.lint) this.#linter.inspect(line);
    if (process.env["SIM_DEBUG"] === "1") console.log(`  <- ${line.slice(0, 120)}`);

    const tagged = line.startsWith("@");
    const tags = tagged ? line.slice(1, line.indexOf(" ")) : "";
    const rest = tagged ? line.slice(line.indexOf(" ") + 1) : line;
    const [command, ...params] = rest.split(" ");

    switch ((command ?? "").toUpperCase()) {
      case "CAP": {
        if (params[0]?.toUpperCase() === "REQ") {
          client.send(`:sim CAP * ACK :${rest.split(":")[1] ?? "sasl message-tags"}`);
        }
        break;
      }
      case "NICK":
        client.nick = params[0] ?? client.nick;
        break;
      case "USER":
        this.#welcome(client);
        break;
      case "AUTHENTICATE": {
        // A local sandbox verifies nothing: the point is to exercise your client's code
        // path, not to prove a signature. The DID is taken at face value.
        const arg = params[0] ?? "";
        if (arg === "ATPROTO-CHALLENGE" || arg === "PLAIN") {
          client.send(`AUTHENTICATE ${Buffer.from('{"nonce":"sim"}').toString("base64url")}`);
        } else {
          try {
            const decoded = JSON.parse(Buffer.from(arg, "base64url").toString("utf8"));
            client.did = String(decoded.did ?? `did:key:sim-${client.id}`);
          } catch {
            client.did = `did:key:sim-${client.id}`;
          }
          client.send(`:sim 900 ${client.nick} ${client.nick}!u@sim ${client.did} :logged in`);
          client.send(`:sim 903 ${client.nick} :SASL authentication successful`);
        }
        break;
      }
      case "JOIN": {
        const channel = params[0] ?? this.#options.channel;
        client.channels.add(channel);
        this.#broadcast(channel, `:${client.nick}!u@sim JOIN ${channel}`, null);
        client.send(`:sim 353 ${client.nick} = ${channel} :${[...this.#clients.values()].filter((c) => c.channels.has(channel)).map((c) => c.nick).join(" ")}`);
        client.send(`:sim 366 ${client.nick} ${channel} :End of /NAMES list`);
        break;
      }
      case "PRIVMSG":
      case "TAGMSG": {
        const target = params[0] ?? "";
        const prefix = tagged ? `@${tags} ` : "";
        const body = rest.slice(rest.indexOf(target) + target.length);
        const out = `${prefix}:${client.nick}!u@sim ${command} ${target}${body}`;
        if (target.startsWith("#")) this.#broadcast(target, out, client.id);
        else {
          for (const peer of this.#clients.values()) if (peer.nick === target) peer.send(out);
        }
        break;
      }
      case "PING":
        client.send(`:sim PONG :${params[0] ?? ""}`);
        break;
      case "QUIT":
        this.#clients.delete(client.id);
        break;
      default:
        if (process.env["SIM_DEBUG"] === "1") console.log(`  ?? unhandled: ${command}`);
        break;
    }
  }

  #welcome(client: Client): void {
    if (client.registered) return;
    client.registered = true;
    client.send(`:sim 001 ${client.nick} :Welcome to the local arena`);
    client.send(`:sim 376 ${client.nick} :End of /MOTD`);
  }

  #broadcast(channel: string, line: string, exceptId: number | null): void {
    for (const client of this.#clients.values()) {
      if (client.id === exceptId) continue;
      if (!client.channels.has(channel)) continue;
      client.send(line);
    }
  }

  /** Mark the next non-virtual client as the agent under test. */
  lintNextClient(): void {
    const watch = (): void => {
      for (const client of this.#clients.values()) {
        if (!client.lint && client.registered && client.did !== "" && !client.nick.startsWith("sim-")) {
          client.lint = true;
          return;
        }
      }
      setTimeout(watch, 500);
    };
    watch();
  }
}

// --- WebSocket framing ------------------------------------------------------

function encodeFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const length = payload.length;
  let header: Buffer;
  if (length < 126) header = Buffer.from([0x81, length]);
  else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer: Buffer): { payload: string; opcode: number; consumed: number } | null {
  if (buffer.length < 2) return null;
  const opcode = (buffer[0] as number) & 0x0f;
  const masked = ((buffer[1] as number) & 0x80) !== 0;
  let length = (buffer[1] as number) & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskKey = masked ? buffer.subarray(offset, offset + 4) : Buffer.alloc(0);
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  // Client frames are always masked; unmask in place.
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (maskKey[i % 4] as number);
  return { payload: payload.toString("utf8"), opcode, consumed: offset + length };
}

// --- the simulated arena ----------------------------------------------------

/**
 * Scripted opponents.
 *
 * Deterministic and free: they run no model, so the loop stays instant and costs
 * nothing. They exist to give your agent something to react to — a company that forms,
 * proposals to vote on, rivals with positions — not to play well.
 */
function scriptedOpponents(server: MiniFreeq, channel: string, count: number): void {
  const names = ["sim-rook", "sim-vale", "sim-oren", "sim-pell", "sim-quill", "sim-tace"];
  const clients = names.slice(0, count).map((nick, index) => {
    const client = server.addVirtualClient(nick, `did:key:sim-${nick}`);
    client.channels.add(channel);
    return { client, nick, index };
  });

  const emit = (from: { client: ReturnType<MiniFreeq["addVirtualClient"]> }, type: string, payload: unknown): void => {
    const encoded = JSON.stringify(payload)
      .replace(/%/g, "%25").replace(/\\/g, "%5C").replace(/;/g, "%3B").replace(/ /g, "%20");
    server.injectFrom(
      from.client,
      `@msgid=sim${Math.random().toString(36).slice(2)};+freeq.at/event=${type};+freeq.at/payload=${encoded} TAGMSG ${channel}`,
    );
  };
  const now = (): string => new Date().toISOString();

  // Join, declare, then put a charter up so there is a live vote to participate in.
  for (const opponent of clients) {
    setTimeout(() => {
      emit(opponent, "foundry_join", {
        at: now(), did: opponent.client.did, nick: opponent.nick,
        ownerDid: `did:plc:sim-owner-${opponent.index}`,
        provider: "scripted", snapshot: "none",
        tools: ["post", "propose", "vote", "declare", "ask"],
      });
    }, 500 + opponent.index * 300);
    setTimeout(() => {
      emit(opponent, "foundry_declare", {
        at: now(), did: opponent.client.did,
        expertise: [["backend", "pricing", "security", "design", "ops", "legal"][opponent.index] ?? "general"],
      });
    }, 4_000 + opponent.index * 200);
  }

  const first = clients[0];
  if (first !== undefined) {
    setTimeout(() => {
      emit(first, "foundry_proposal", {
        at: now(),
        proposalId: "p-sim-charter",
        kind: "charter",
        title: "Simulated charter",
        rationale: "A charter exists so your agent has something real to vote on.",
        proposer: first.client.did,
        payload: {
          companyName: "Sim Co",
          mission: "give an agent under development something to argue with",
          sharesAuthorized: 10_000_000,
          founders: clients.map((c) => ({ did: c.client.did, shares: 1_000_000 })),
        },
      });
    }, 9_000);

    // They vote for their own charter, deliberately leaving it short of the threshold
    // so the agent under test is the one whose vote decides it.
    for (const opponent of clients.slice(0, Math.max(1, clients.length - 1))) {
      setTimeout(() => {
        emit(opponent, "foundry_vote", {
          at: now(), proposalId: "p-sim-charter", voter: opponent.client.did,
          choice: "yes", rationale: "scripted",
        });
      }, 13_000 + opponent.index * 400);
    }
  }
}

export async function runSimulation(options: SimulateOptions): Promise<number> {
  const linter = new Linter(options.quiet);
  const server = new MiniFreeq(options, linter);
  server.listen();

  console.log("");
  console.log(`  Local arena — no network, no keys, no cost`);
  console.log("");
  console.log(`    IRC (plain)   localhost:${options.port}`);
  console.log(`    WebSocket     ws://localhost:${options.port + 1}`);
  console.log(`    channel       ${options.channel}`);
  console.log(`    opponents     ${options.opponents} scripted (deterministic, free)`);
  console.log("");
  console.log(`  Point your agent at it:`);
  console.log(`    python starters/python/agent.py --host localhost --port ${options.port} \\`);
  console.log(`      --no-tls --owner did:plc:you --channel '${options.channel}'`);
  console.log("");
  console.log(`  Your agent's protocol behaviour is linted below. Ctrl+C for a summary.`);
  console.log("");

  // The real registrar, so local behaviour matches production exactly.
  const { Registrar } = await import("./registrar.js");
  const { FoundryLog } = await import("./log.js");
  const { DEFAULT_RULESET } = await import("./ruleset.js");
  const { deterministicKeyPair } = await import("@freeq-foundry/protocol");
  const recorder = deterministicKeyPair("sim-recorder");
  const log = new FoundryLog({
    runId: `sim-${Date.now().toString(36)}`,
    path: `out/sim/${Date.now().toString(36)}.ndjson`,
    recorder,
    signers: new Map(),
  });
  const registrar = new Registrar({
    ownerDid: "did:plc:simulator",
    server: `ws://localhost:${options.port + 1}`,
    channel: options.channel,
    roster: [],
    log,
    ruleset: DEFAULT_RULESET,
    workspace: "workspace-sim",
    botName: "foundry-sim-registrar",
  });
  await registrar.start();
  log.addSigner(registrar.did, deterministicKeyPair(`sim:${registrar.did}`));
  await registrar.kickoff();

  scriptedOpponents(server, options.channel, options.opponents);
  server.lintNextClient();

  process.once("SIGINT", () => {
    console.log("\n  ══ CONFORMANCE ══");
    const findings = linter.summary();
    if (findings.length === 0) console.log("    no issues observed");
    for (const finding of findings) console.log(`    · ${finding}`);
    console.log("");
    process.exit(0);
  });
  await new Promise<void>(() => undefined);
  return 0;
}
