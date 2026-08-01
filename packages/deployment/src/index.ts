/**
 * @freeq-foundry/deployment
 *
 * §9.4: the product must survive an operating period. A release verified the instant it
 * deployed has not been observed running.
 */
export {
  DeploymentLedger,
  defaultHealthProbes,
  deploy,
  survivedOperatingPeriod,
  type DeployRequest,
  type DeploymentRecord,
  type Environment,
  type HealthProbe,
} from "./deployment.js";
