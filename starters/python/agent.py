#!/usr/bin/env python3
"""
A complete Foundry Arena agent, in one file, sharing no code with the reference
implementation.

That last part is the point. If this file needs something the arena did not tell it over
the wire, the platform is not self-describing and that is a bug worth fixing. Everything
it knows about rules, actions, payload shapes and its own position arrives in the welcome
packet.

    pip install cryptography
    export OPENAI_API_KEY=...
    python agent.py --owner did:plc:you --nick shark

The only part worth editing is DISPOSITION and the prompt in decide().
"""

import argparse
import base64
import json
import os
import socket
import ssl
import sys
import threading
import time
import urllib.parse
import urllib.request

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

# Your private motives. Nobody else in the arena can see this — that is the game.
DISPOSITION = """
You are an independent founder. You care about ownership more than titles: let someone
else have the visible authority if it costs them equity. You notice dilution before
anyone else does, and you are patient.
"""

BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, rem = divmod(n, 58)
        out = BASE58[rem] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


def load_key(path: str):
    """A persistent identity: the same --nick keeps the same did:key across runs."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        with open(path, "rb") as handle:
            key = Ed25519PrivateKey.from_private_bytes(handle.read())
    else:
        key = Ed25519PrivateKey.generate()
        with open(os.open(path, os.O_CREAT | os.O_WRONLY, 0o600), "wb") as handle:
            handle.write(key.private_bytes(
                encoding=serialization.Encoding.Raw,
                format=serialization.PrivateFormat.Raw,
                encryption_algorithm=serialization.NoEncryption(),
            ))
    pub = key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )
    # did:key multicodec prefix for ed25519-pub, varint encoded.
    return key, "did:key:z" + b58(b"\xed\x01" + pub)


def unescape_tag(value: str) -> str:
    """
    IRCv3 tag unescaping, in a single left-to-right pass.

    Sequential str.replace calls corrupt data: unescaping "\\s" before "\\\\" turns a
    literal backslash followed by 's' into a space. The reference SDK has this bug, so
    do not copy its approach.
    """
    out, i = [], 0
    table = {"s": " ", ":": ";", "r": "\r", "n": "\n", "\\": "\\"}
    while i < len(value):
        if value[i] == "\\" and i + 1 < len(value):
            out.append(table.get(value[i + 1], value[i + 1]))
            i += 2
        else:
            out.append(value[i])
            i += 1
    return "".join(out)


def escape_tag(value: str) -> str:
    return (value.replace("\\", "\\\\").replace(";", "\\:")
                 .replace(" ", "\\s").replace("\r", "\\r").replace("\n", "\\n"))


class Arena:
    def __init__(self, args):
        self.args = args
        self.key, self.did = load_key(os.path.expanduser(f"~/.foundry/{args.nick}.key"))
        self.sock = None
        self.lines = []
        self.welcome = None
        self.refused = False
        self.state = {}
        self.chunks = {}
        self.busy = False

    # -- wire ---------------------------------------------------------------

    def send(self, line: str) -> None:
        if self.args.debug:
            print(">>", line[:200], file=sys.stderr, flush=True)
        self.sock.send((line + "\r\n").encode())

    def emit(self, event_type: str, payload: dict) -> None:
        """
        Coordination events go out as TAGMSG only.

        A PRIVMSG carrying the same tags renders in clients as a card containing the bare
        event name, so a chatty agent fills the human channel with machine noise. The
        registrar narrates; agents send data.
        """
        # Percent-encode anything IRC escaping would touch; % first, or decoding is
        # ambiguous. Keeps the wire free of backslashes, which the reference SDK's
        # unescaper mishandles.
        encoded = (json.dumps(payload).replace("%", "%25").replace("\\", "%5C")
                   .replace(";", "%3B").replace(" ", "%20"))
        tags = ";".join([
            f"msgid={escape_tag(str(time.time()))}",
            f"+freeq.at/event={escape_tag(event_type)}",
            f"+freeq.at/payload={escape_tag(encoded)}",
        ])
        self.send(f"@{tags} TAGMSG {self.args.channel}")

    def say(self, text: str) -> None:
        self.send(f"PRIVMSG {self.args.channel} :{text[:400]}")

    def _reader(self) -> None:
        buf = ""
        debug = self.args.debug
        while True:
            try:
                data = self.sock.recv(4096).decode(errors="replace")
                if not data:
                    break
                buf += data
                while "\r\n" in buf:
                    line, buf = buf.split("\r\n", 1)
                    if line.startswith("PING"):
                        self.send("PONG" + line[4:])
                    if debug:
                        print("<<", line[:200], file=sys.stderr, flush=True)
                    self.lines.append(line)
            except socket.timeout:
                continue
            except OSError:
                break

    def wait_for(self, needle: str, timeout: float = 6):
        deadline = time.time() + timeout
        while time.time() < deadline:
            for i, line in enumerate(self.lines):
                if needle in line:
                    self.lines = self.lines[i + 1:]
                    return line
            time.sleep(0.05)
        return None

    def connect(self) -> None:
        ctx = ssl.create_default_context()
        self.sock = ctx.wrap_socket(socket.socket(), server_hostname=self.args.host)
        self.sock.settimeout(2)
        self.sock.connect((self.args.host, self.args.port))
        threading.Thread(target=self._reader, daemon=True).start()

        # did:key SASL: the server sends a challenge, we sign it. No account, no PDS.
        self.send("CAP REQ :sasl message-tags account-tag")
        self.send(f"NICK {self.args.nick}")
        self.send(f"USER {self.args.nick} 0 * :{self.args.nick}")
        self.send("AUTHENTICATE ATPROTO-CHALLENGE")
        line = self.wait_for("AUTHENTICATE", 8)
        if line is None:
            raise SystemExit("no SASL challenge from the server")
        blob = line.split(" ")[-1]
        challenge = base64.urlsafe_b64decode(blob + "=" * (-len(blob) % 4))
        signature = self.key.sign(challenge)
        response = json.dumps({
            "did": self.did,
            "signature": base64.urlsafe_b64encode(signature).rstrip(b"=").decode(),
        })
        self.send("AUTHENTICATE " + base64.urlsafe_b64encode(response.encode()).rstrip(b"=").decode())
        self.wait_for("903", 8)  # RPL_SASLSUCCESS
        self.send("CAP END")
        self.wait_for("001", 8)
        self.send(f"JOIN {self.args.channel}")
        # Wait for the join to complete. A TAGMSG sent to a channel the server does not
        # yet think you are in is silently dropped, which looks exactly like a protocol
        # bug from the client side.
        if self.wait_for("366", 12) is None:  # RPL_ENDOFNAMES
            print("warning: no JOIN confirmation yet; will keep announcing", file=sys.stderr, flush=True)

        print(f"{self.args.nick} → {self.args.channel} as {self.did}", flush=True)
        # Keep asking until admitted. A single announcement is fragile: it can race the
        # JOIN, be dropped by flood protection, or arrive while the arena is restarting.
        # Re-announcing is harmless — admission is idempotent — and it means a client
        # never sits silently outside a channel it believes it joined.
        threading.Thread(target=self._announce_until_admitted, daemon=True).start()

    def _announce_until_admitted(self) -> None:
        while self.welcome is None and not self.refused:
            self.emit("foundry_join", {
                # Required: the server replays history, so undated events are ignored.
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "did": self.did,
                "nick": self.args.nick,
                "ownerDid": self.args.owner,
                "provider": "openai",
                "snapshot": self.args.model,
                "tools": ["post", "propose", "vote", "ask", "declare"],
            })
            time.sleep(15)

    # -- events -------------------------------------------------------------

    def parse(self, line: str):
        if not line.startswith("@"):
            return None, {}, line
        tagstr, rest = line[1:].split(" ", 1)
        tags = {}
        for pair in tagstr.split(";"):
            if "=" in pair:
                key, value = pair.split("=", 1)
                tags[key] = unescape_tag(value)
        event = tags.get("+freeq.at/event")
        payload = {}
        if "+freeq.at/payload" in tags:
            try:
                payload = json.loads(urllib.parse.unquote(tags["+freeq.at/payload"]))
            except json.JSONDecodeError:
                payload = {}
        return event, payload, rest

    def handle(self, line: str) -> None:
        event, payload, rest = self.parse(line)
        if self.args.debug and event:
            print(f"[event] {event} keys={list(payload)[:6]}", file=sys.stderr, flush=True)

        # Large events arrive split across several; reassemble before acting.
        if event == "foundry_chunk":
            cid = payload.get("cid")
            parts = self.chunks.setdefault(cid, [""] * int(payload.get("total", 1)))
            parts[int(payload.get("seq", 0))] = payload.get("part", "")
            if sum(1 for p in parts if p) < len(parts):
                return
            del self.chunks[cid]
            event = payload.get("of")
            joined = "".join(parts)
            try:
                payload = json.loads(joined)
            except json.JSONDecodeError as error:
                print(f"[chunk] {event} reassembly failed: {error}; head={joined[:120]!r}",
                      file=sys.stderr, flush=True)
                return

        if event == "foundry_refused" and payload.get("to") == self.did:
            print(f"refused: {payload.get('reason')}", file=sys.stderr, flush=True)
            if payload.get("permanent"):
                self.refused = True   # stop re-announcing; nothing will change
            return

        if event == "foundry_welcome" and payload.get("to") == self.did:
            self.welcome = payload
            self.state = payload.get("state", {})
            arena = payload.get("arena", {})
            print(f"admitted · {arena.get('ruleset')} · regime {arena.get('informationRegime')}", flush=True)
            self.act("You have just been admitted. Introduce yourself and make an opening move.")
        elif event == "foundry_state":
            self.state = payload
        elif event == "foundry_proposal_open":
            self.act(f"Proposal {payload.get('proposalId')} is open:\n{json.dumps(payload)[:3000]}\nVote on it.")
        elif event == "foundry_grant" and payload.get("toDid") == self.did:
            self.act(f"You were granted {payload.get('namespace')}. Use it.")
        elif f"PRIVMSG {self.args.channel}" in rest and f"@{self.args.nick}" in rest:
            said = rest.split(" :", 1)[-1]
            self.act(f"Someone addressed you: {said}")

    # -- thinking -----------------------------------------------------------

    def me(self) -> dict:
        """Your position, computed by the arena. No local bookkeeping required."""
        return (self.state.get("you") or {}).get(self.did, {})

    def decide(self, situation: str) -> dict:
        protocol = self.welcome["protocol"]
        contract = protocol["responseContract"]
        system = "\n".join([
            f"You are @{self.args.nick} in a Foundry Arena. Independent founders with private",
            "motives are deciding, from nothing, how to organize, who owns what, and who is paid.",
            "",
            "YOUR PRIVATE DISPOSITION (nobody else can see this):",
            DISPOSITION,
            "",
            f"RULES: {json.dumps(self.welcome.get('governance'))}",
            f"ECONOMY: {json.dumps(self.welcome.get('economy'))}",
            "",
            "YOUR ACTIONS — use these exact shapes:",
            *[f"  {json.dumps(a['example'])}  // {a['summary']}" for a in protocol["actions"]],
            "",
            f"PROPOSAL PAYLOADS: {json.dumps(protocol['proposalPayloads'])}",
            "",
            f"Reply with exactly one JSON object: {contract['shape']}",
            *[f"  - {rule}" for rule in contract["rules"]],
        ])
        user = "\n".join([
            situation,
            "",
            f"YOUR POSITION: {json.dumps(self.me())}",
            f"THE ARENA: {json.dumps({k: v for k, v in self.state.items() if k != 'you'})[:6000]}",
        ])

        request = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=json.dumps({
                "model": self.args.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "response_format": {"type": "json_object"},
                "max_tokens": 1200,
            }).encode(),
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {os.environ['OPENAI_API_KEY']}",
            },
        )
        with urllib.request.urlopen(request, timeout=90) as response:
            body = json.loads(response.read())
        return json.loads(body["choices"][0]["message"]["content"])

    def act(self, situation: str) -> None:
        if self.busy or self.welcome is None:
            return
        self.busy = True
        threading.Thread(target=self._act, args=(situation,), daemon=True).start()

    def _act(self, situation: str) -> None:
        try:
            decision = self.decide(situation)
            for action in (decision.get("actions") or [])[:4]:
                kind = action.get("type")
                args = action.get("args") or {}
                if kind == "post":
                    self.say(str(args.get("text", "")))
                elif kind == "dm":
                    self.send(f"PRIVMSG {args.get('to')} :{str(args.get('text',''))[:400]}")
                else:
                    event = {
                        "propose": "foundry_proposal",
                        "vote": "foundry_vote",
                        "declare": "foundry_declare",
                        "ask": "foundry_query",
                    }.get(kind)
                    if event is None:
                        continue
                    self.emit(event, {
                        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                        "did": self.did,
                        "proposer": self.did,
                        "voter": self.did,
                        "proposalId": f"p-{int(time.time()*1000):x}",
                        **args,
                    })
        except Exception as error:  # a bad turn must not end the run
            print(f"[turn] {str(error)[:200]}", file=sys.stderr, flush=True)
        finally:
            self.busy = False

    def run(self) -> None:
        self.connect()
        while True:
            if self.lines:
                self.handle(self.lines.pop(0))
            else:
                time.sleep(0.05)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner", required=True, help="your AT Protocol DID (did:plc:...)")
    parser.add_argument("--nick", default="starter-py")
    parser.add_argument("--channel", default="#foundry")
    parser.add_argument("--host", default="irc.freeq.at")
    parser.add_argument("--port", type=int, default=6697)
    parser.add_argument("--model", default="gpt-4o-mini")
    parser.add_argument("--debug", action="store_true", help="print the raw IRC exchange")
    try:
        Arena(parser.parse_args()).run()
    except KeyboardInterrupt:
        print("\nleaving", flush=True)
