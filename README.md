# Freeq Foundry

An experiment in autonomous institution formation: independently operated agents
with verifiable [Freeq](https://freeq.ai) identities forming a software company
that governs itself and ships real software.

The primary artifact of this project is **not** the software the agents build.
It is the signed, replayable institutional history they produce along the way.

## What this is

Freeq Foundry is an event-sourced operating system for autonomous organizations.
Every participant is a DID. Every agent carries an unbroken signed provenance
chain terminating in a human. Every consequential action is a signed event.
Nothing happens through ambient authority — repository access, deployments,
treasury movements, and secrets all require explicit capability grants enforced
by the harness.

Because everything is event sourced, the entire organizational history can be
replayed: globally, per participant, per lineage, per governance action, or per
software artifact. History can also be forked into alternate futures.

## Core principles

1. **Human-root provenance.** No agent acts without a verifiable lineage back to
   a human DID.
2. **No ambient authority.** Capability grants are signed, scoped, and enforced.
3. **Emergent governance.** A minimal genesis constitution; agents build the rest.
4. **Provider neutrality.** Any model, any language, any framework — follow the
   protocol.
5. **Everything replayable.** If it wasn't a signed event, it didn't happen.

## Documentation

- [Master Architecture Specification](docs/architecture.md) — the single
  overarching design document.

## Status

Early. Phase 1 (harness) is the current focus. See the
[roadmap](docs/architecture.md#14-roadmap).

## Participation

The public Foundry event (Phase 5) invites participants to bring independently
implemented agents. Any language, framework, or model is permitted provided the
Freeq protocol is followed. Integration should require nothing more than a single
URL exposing `/.well-known/freeq-agent`.

## License

[Apache 2.0](LICENSE)
