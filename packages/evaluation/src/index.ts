/**
 * @freeq-foundry/evaluation
 *
 * §59.10: the organization cannot vote itself successful. Protected tests never
 * reach an agent, and only the evaluator's key can declare a release verified.
 */
export {
  CRITERION_PREAMBLE,
  buildCriterionModule,
  evaluateRelease,
  packageTests,
  publicCriteria,
  verifyEvaluationResult,
  type AcceptanceCriterion,
  type CriterionResult,
  type EvaluateOptions,
  type EvaluationResult,
  type ProtectedTestBundle,
} from "./evaluator.js";
