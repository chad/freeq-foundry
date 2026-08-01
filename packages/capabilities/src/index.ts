/**
 * @freeq-foundry/capabilities
 *
 * Enforces §6.5: joining grants nothing. Default deny, and every decision is
 * explicable (§20.4).
 */
export {
  CapabilityNamespaces,
  KNOWN_NAMESPACES,
  authorize,
  checkAttenuation,
  checkMultiParty,
  namespaceCovers,
  type AttenuationCheck,
  type AttenuationRequest,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type CapabilityNamespace,
  type ConsideredGrant,
  type MultiPartyCheck,
  type MultiPartyRequirement,
} from "./authorize.js";
