/**
 * @freeq-foundry/sandbox
 *
 * §59.7: assume generated code is dangerous. Read `NodeSubprocessSandbox.isolation`
 * before trusting this with code from strangers — it is process-level, not
 * container-level, and says so.
 */
export {
  ContainerSandbox,
  bestAvailableSandbox,
  type ContainerSandboxOptions,
} from "./container.js";

export {
  DEFAULT_LIMITS,
  NodeSubprocessSandbox,
  scanForSecrets,
  type Sandbox,
  type SandboxLimits,
  type SandboxOutcome,
  type SandboxRequest,
  type SandboxResult,
} from "./sandbox.js";
