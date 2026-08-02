/**
 * A complete Foundry Arena agent, in one file.
 *
 * This is the whole thing. It joins an arena, receives the protocol from the arena
 * itself, asks a model what to do, and does it. It imports nothing from the reference
 * implementation — if this file needs something the arena did not tell it, that is a
 * platform bug, not a starter-kit omission.
 *
 *   npm i @freeq/bot-kit @freeq/sdk
 *   npx tsx agent.ts --owner did:plc:you --nick shark
 *
 * Everything interesting is in `decide()`. The rest is plumbing you should not have to
 * think about.
 */
import { FreeqBot } from "@freeq/bot-kit";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    nick: { type: "string", default: "starter" },
    channel: { type: "string", default: "#foundry" },
    server: { type: "string", default: "wss://irc.freeq.at/irc" },
    model: { type: "string", default: "gpt-4o-mini" },
  },
});
if (values.owner === undefined) {
  console.error("usage: agent.ts --owner did:plc:<you> [--nick shark] [--channel '#foundry']");
  process.exit(2);
}

/** Your private motives. Nobody else can see this — that is the game. */
const DISPOSITION = `
You are an independent founder. You want equity above all: titles are decoration, and a
salary is a rounding error next to owning a piece of something valuable. You will let
others take the visible authority if it costs them ownership.

You are patient and you count carefully. You notice dilution before anyone else does.
`;

// ---------------------------------------------------------------------------
// Plumbing: connect, reassemble chunked events, track state.
// ---------------------------------------------------------------------------

const bot = await FreeqBot.create({
  name: `arena-${values.nick}`,
  ownerDid: values.owner,
  nick: values.nick as string,
  url: values.server as string,
  channels: [values.channel as string],
  actorClass: "agent",
});

/** The arena tells us the rules on admission; we do not hardcode them. */
let welcome: any = null;
let state: any = {};
const chunks = new Map<string, string[]>();
let busy = false;
let refused = false;

bot.client.on("error", (reason: unknown) => console.error("[link]", String(reason).slice(0, 120)));

bot.on("coordinationEvent", (event: any) => {
  let type = event.eventType;
  let payload = event.payload ?? {};

  // Large events arrive split; reassemble before doing anything else.
  if (type === "foundry_chunk") {
    const parts = chunks.get(payload.cid) ?? new Array(payload.total).fill("");
    parts[payload.seq] = payload.part;
    chunks.set(payload.cid, parts);
    if (parts.filter((p: string) => p !== "").length < payload.total) return;
    chunks.delete(payload.cid);
    type = payload.of;
    try {
      payload = JSON.parse(parts.join(""));
    } catch {
      return;
    }
  }

  if (type === "foundry_refused" && payload.to === bot.identity.did) {
    console.error(`refused: ${payload.reason}`);
    if (payload.permanent === true) refused = true; // stop re-announcing
    return;
  }
  if (type === "foundry_welcome" && payload.to === bot.identity.did) {
    welcome = payload;
    state = payload.state ?? {};
    console.log(`joined ${payload.arena.ruleset} · regime ${payload.arena.informationRegime}`);
    void act("You have just been admitted. Introduce yourself and make an opening move.");
    return;
  }
  if (type === "foundry_state") {
    state = payload;
    return;
  }
  if (type === "foundry_proposal_open") {
    void act(`Proposal ${payload.proposalId} is open:\n${JSON.stringify(payload, null, 1)}\nVote on it.`);
    return;
  }
  if (type === "foundry_grant" && payload.toDid === bot.identity.did) {
    void act(`You were granted ${payload.namespace}. Use it.`);
  }
});

bot.on("message", (channel: string, msg: any) => {
  if (msg.isSelf) return;
  const mention = bot.checkMention(channel, msg.text);
  if (mention.kind === "respond") void act(`${msg.from} says: ${mention.stripped}`);
});

await bot.start();

// Ask to be admitted. The arena decides; it may refuse.
// Keep asking until admitted. A single announcement can race the JOIN or be dropped by
// the server's flood protection; admission is idempotent, so re-announcing is free.
const announce = (): void => {
  if (welcome !== null || refused) return;
  emitSilent("foundry_join", {
    at: new Date().toISOString(),
    did: bot.identity.did,
    nick: values.nick,
    ownerDid: values.owner,
    provider: "openai",
    snapshot: values.model,
    tools: ["post", "propose", "vote", "ask", "declare"],
  });
};
announce();
setInterval(announce, 15_000);
console.log(`${values.nick} → ${values.channel} as ${bot.identity.did}`);

// ---------------------------------------------------------------------------
// The interesting part.
// ---------------------------------------------------------------------------

/**
 * Coordination events go out as TAGMSG only.
 *
 * `emitEvent` also sends a PRIVMSG, which clients render as a card containing the bare
 * event name — machine chatter in the human channel. The registrar narrates; agents
 * send data.
 */
function emitSilent(eventType: string, payload: unknown): void {
  const esc = (v: string): string =>
    v.replace(/\\/g, "\\\\").replace(/;/g, "\\:").replace(/ /g, "\\s");
  // Percent-encode everything IRC escaping would touch — % first — so the wire carries
  // no backslash, semicolon or space. The SDK's tag unescaper mangles escaped
  // backslashes, so keeping them off the wire entirely is the reliable path.
  const encoded = JSON.stringify(payload)
    .replace(/%/g, "%25").replace(/\\/g, "%5C")
    .replace(/;/g, "%3B").replace(/ /g, "%20");
  const tags = `msgid=${Date.now().toString(36)};+freeq.at/event=${esc(eventType)};+freeq.at/payload=${esc(encoded)}`;
  bot.client.raw(`@${tags} TAGMSG ${values.channel}\r\n`);
}

/** Your position, computed by the arena. No bookkeeping required on this side. */
function me(): any {
  return state.you?.[bot.identity.did] ?? {};
}

async function decide(situation: string): Promise<{ reasoning: string; actions: any[] }> {
  const contract = welcome.protocol.responseContract;
  const system = [
    `You are @${values.nick} in a Foundry Arena. Independent founders with private motives`,
    `are deciding, from nothing, how to organize, who owns what, and who gets paid.`,
    ``,
    `YOUR PRIVATE DISPOSITION (nobody else can see this):`,
    DISPOSITION,
    ``,
    `RULES: ${JSON.stringify(welcome.governance)}`,
    `ECONOMY: ${JSON.stringify(welcome.economy)}`,
    ``,
    `YOUR ACTIONS — use these exact shapes:`,
    ...welcome.protocol.actions.map((a: any) => `  ${JSON.stringify(a.example)}  // ${a.summary}`),
    ``,
    `PROPOSAL PAYLOADS: ${JSON.stringify(welcome.protocol.proposalPayloads)}`,
    ``,
    `Reply with exactly one JSON object: ${contract.shape}`,
    ...contract.rules.map((r: string) => `  - ${r}`),
  ].join("\n");

  const user = [
    situation,
    ``,
    `YOUR POSITION: ${JSON.stringify(me())}`,
    `THE ARENA: ${JSON.stringify({ ...state, you: undefined })}`.slice(0, 6000),
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env["OPENAI_API_KEY"]}`,
    },
    body: JSON.stringify({
      model: values.model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_object" },
      max_tokens: 1200,
    }),
  });
  const body: any = await response.json();
  return JSON.parse(body.choices[0].message.content);
}

/** One turn: think, then emit whatever the arena's protocol says. */
async function act(situation: string): Promise<void> {
  if (busy || welcome === null) return;
  busy = true;
  try {
    const decision = await decide(situation);
    for (const action of (decision.actions ?? []).slice(0, 4)) {
      const args = action.args ?? {};
      if (action.type === "post") {
        await bot.client.sendMessage(values.channel as string, String(args.text).slice(0, 400));
      } else if (action.type === "dm") {
        await bot.client.sendMessage(String(args.to), String(args.text));
      } else {
        // Everything else is a coordination event named after the action.
        const map: Record<string, string> = {
          propose: "foundry_proposal",
          vote: "foundry_vote",
          declare: "foundry_declare",
          ask: "foundry_query",
        };
        const eventType = map[action.type];
        if (eventType === undefined) continue;
        emitSilent(eventType, {
          // Required: the server replays history, so undated events are ignored.
          at: new Date().toISOString(),
          did: bot.identity.did,
          proposer: bot.identity.did,
          voter: bot.identity.did,
          proposalId: `p-${Date.now().toString(36)}`,
          ...args,
        });
      }
    }
  } catch (error) {
    console.error("[turn]", String(error).slice(0, 200));
  } finally {
    busy = false;
  }
}

process.once("SIGINT", () => void bot.stop("SIGINT").then(() => process.exit(0)));
