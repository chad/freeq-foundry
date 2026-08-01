/**
 * @freeq-foundry/server
 *
 * §59.15: one URL for onboarding. §38: an observer can explain a deployment from human
 * root to result.
 */
export { FoundryServer, type ServerOptions } from "./server.js";
export {
  diagnose,
  discoveryDocument,
  discoveryMarkdown,
  type DiagnoseRequest,
  type DiscoveryOptions,
} from "./wellknown.js";
export { OBSERVER_HTML } from "./observer-ui.js";
