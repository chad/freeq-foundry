/**
 * Machine-only coordination events.
 *
 * `emitEvent` sends a TAGMSG *and* a PRIVMSG, defaulting the PRIVMSG body to the bare
 * event type when no `humanText` is given. So every internal broadcast — state
 * snapshots, directory updates, chunked file transfers, query replies — rendered in the
 * client as a card containing the word `foundry_state`, several times a minute. The
 * machine layer was narrating itself to humans.
 *
 * A TAGMSG carries the tags without a message body. Agents still receive the event
 * exactly as before; people simply stop seeing the plumbing.
 *
 * ## Who speaks
 *
 * With this available the division becomes clean, and it is worth stating because it is
 * an editorial decision rather than a technical one:
 *
 *   - **Agents emit silently.** A proposal, vote, declaration, or file chunk is data.
 *   - **The registrar narrates.** It is the one voice in the channel for what happened,
 *     in prose, once.
 *   - **Agents speak only deliberately**, through `post` and `dm`.
 *
 * Before this, a single declaration produced an agent's card, the registrar's sentence,
 * and a state card — three renderings of one fact, two of them noise.
 */

/** Minimal IRC tag escaping, matching the SDK's own encoding. */
function escapeTagValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\:")
    .replace(/ /g, "\\s")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

let counter = 0;

function mintEventId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.floor(Math.random() * 46_656).toString(36)}`;
}

export interface SilentClient {
  raw(line: string): void;
}

/**
 * Safe payload size for one event.
 *
 * IRCv3 caps client tags at 4094 bytes and freeq's own parser warns well before its
 * 8192-byte line limit, noting a live incident where an 8.6KB body was truncated at
 * ~8KB and produced a baffling "Unterminated string" downstream. A state broadcast
 * carrying shares, salaries, offices, and expertise for a dozen participants goes past
 * that without anyone noticing, so anything larger is split rather than risked.
 */
const MAX_PAYLOAD = 2_600;

/**
 * Emit a coordination event that only machines see.
 *
 * Payload encoding mirrors `emitEvent`: percent-encode `;` and space so the value
 * survives both IRCv3 tag escaping and the server's URL-decode pass.
 */
export function emitSilent(
  client: SilentClient,
  channel: string,
  eventType: string,
  payload: unknown,
  opts: { readonly refId?: string } = {},
): string {
  const eventId = mintEventId();
  const encoded = JSON.stringify(payload).replace(/;/g, "%3B").replace(/ /g, "%20");
  const tags = [
    `msgid=${escapeTagValue(eventId)}`,
    `+freeq.at/event=${escapeTagValue(eventType)}`,
    `+freeq.at/payload=${escapeTagValue(encoded)}`,
    ...(opts.refId === undefined ? [] : [`+freeq.at/task-id=${escapeTagValue(opts.refId)}`]),
  ].join(";");
  client.raw(`@${tags} TAGMSG ${channel}\r\n`);
  return eventId;
}

/**
 * Emit an event, splitting it across several if it is too large for one tag.
 *
 * Receivers pass every incoming event through {@link Reassembler}, which returns the
 * original payload once the last part lands. Nothing else in the system needs to know
 * whether a given event travelled whole or in pieces.
 */
export function emitSilentSized(
  client: SilentClient,
  channel: string,
  eventType: string,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  if (body.length <= MAX_PAYLOAD) {
    emitSilent(client, channel, eventType, payload);
    return;
  }
  const cid = mintEventId();
  const total = Math.ceil(body.length / MAX_PAYLOAD);
  for (let seq = 0; seq < total; seq++) {
    emitSilent(client, channel, "foundry_chunk", {
      cid,
      seq,
      total,
      of: eventType,
      part: body.slice(seq * MAX_PAYLOAD, (seq + 1) * MAX_PAYLOAD),
    });
  }
}

/**
 * Reassembles split events.
 *
 * Incomplete sets are dropped once they age out: a sender that disconnects mid-transfer
 * must not pin its partial payload in memory for the rest of the run.
 */
export class Reassembler {
  readonly #parts = new Map<string, { parts: string[]; total: number; at: number }>();

  /**
   * Feed an event. Returns the reconstructed event when a split one completes,
   * `passthrough` for ordinary events, and `undefined` while parts are still missing.
   */
  accept(
    eventType: string,
    payload: Record<string, unknown>,
  ): { eventType: string; payload: Record<string, unknown> } | undefined {
    if (eventType !== "foundry_chunk") return { eventType, payload };

    const cid = String(payload["cid"] ?? "");
    const total = Number(payload["total"] ?? 0);
    const seq = Number(payload["seq"] ?? 0);
    if (cid === "" || total <= 0) return undefined;

    const entry = this.#parts.get(cid) ?? { parts: new Array<string>(total).fill(""), total, at: Date.now() };
    entry.parts[seq] = String(payload["part"] ?? "");
    this.#parts.set(cid, entry);

    const cutoff = Date.now() - 120_000;
    for (const [key, value] of this.#parts) if (value.at < cutoff) this.#parts.delete(key);

    if (entry.parts.filter((p) => p !== "").length < total) return undefined;
    this.#parts.delete(cid);
    try {
      return {
        eventType: String(payload["of"] ?? "unknown"),
        payload: JSON.parse(entry.parts.join("")) as Record<string, unknown>,
      };
    } catch {
      // A corrupt reassembly is dropped rather than delivered as half a fact.
      return undefined;
    }
  }
}
