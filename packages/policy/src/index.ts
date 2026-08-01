/**
 * @freeq-foundry/policy
 *
 * `freeq-rules-v1` — a conjunction of comparisons over a fixed attribute
 * vocabulary. No disjunction, no negation, no arithmetic, no loops. The
 * restriction is what makes attenuation checking decidable (ADR-0010).
 *
 * Zero runtime dependencies: this sits in the authorization path, where a bug is
 * a privilege escalation.
 */
export {
  POLICY_LANGUAGE,
  PolicyParseError,
  formatPolicy,
  parsePolicy,
  type Comparison,
  type Expression,
  type Literal,
  type Operator,
} from "./parse.js";

export {
  POLICY_ENGINE_VERSION,
  attributesOf,
  evaluateExpression,
  evaluatePolicy,
  expressionNarrows,
  globMatches,
  globNarrows,
  narrows,
  validateAttributes,
  type AttributeValue,
  type Decision,
  type NarrowingResult,
  type PolicyContext,
} from "./evaluate.js";
