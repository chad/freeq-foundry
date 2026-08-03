/**
 * @freeq/bot-kit — on-disk persistence + announce-sequence orchestration for
 * freeq bots, on top of {@link https://www.npmjs.com/package/@freeq/sdk @freeq/sdk}.
 *
 * Usage:
 *   const bot = await FreeqBot.create({ name, ownerDid, nick, url });
 *   bot.on('message', (ch, msg) => bot.client.sendMessage(ch, `echo: ${msg.text}`));
 *   await bot.start();
 *
 *   process.once('SIGINT',  () => bot.stop('SIGINT').then(()  => process.exit(0)));
 *   process.once('SIGTERM', () => bot.stop('SIGTERM').then(() => process.exit(0)));
 */
export { FreeqBot } from "./bot.js";
export type { ActorClass, FreeqBotCreateOptions, FreeqBotStartOptions, FreeqBotStopOptions, MentionResult, MentionMatcher, } from "./bot.js";
export { matchMention } from "./mention.js";
export { FreeqClient, fetchProfile } from "@freeq/sdk";
export type { FreeqEvents, NickCollisionPolicy, TransportState } from "@freeq/sdk";
export { loadOrCreateIdentity } from "./identity.js";
export type { AgentIdentity, LoadOrCreateIdentityOptions, } from "./identity.js";
export { loadDelegation, loadOrMintDelegation, buildDelegation, signDelegation, canonicalizeForSigning, } from "./delegation.js";
export type { DelegationCert, LoadDelegationOptions, LoadOrMintDelegationOptions, BuildDelegationOptions, } from "./delegation.js";
export { createDaemonCLI, readPidIfAlive } from "./daemon-cli.js";
export type { CreateDaemonCLIOptions, DaemonPaths, DaemonHandle, DaemonOpts, DoctorCheck, DoctorResult, } from "./daemon-cli.js";
export { createDidMap } from "./did-map.js";
export type { DidMapSource, DidMapSave, DidMapBaseOptions, DidMapMutableOptions, DidMapReadOnly, DidMapMutable, } from "./did-map.js";
export { createDidResolver } from "./did-resolver.js";
export type { DidResolver, DidResolverClient, DidResolverOptions, ResolveOpts, } from "./did-resolver.js";
export { createTurnGate } from "./turn-gate.js";
export type { CreateTurnGateOptions, CyclePolicy, EvaluateArgs as TurnGateEvaluateArgs, GateDecision, TurnGate, TurnGateState, } from "./turn-gate.js";
//# sourceMappingURL=index.d.ts.map