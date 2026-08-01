/**
 * @freeq-foundry/observability
 *
 * §59.16: every important interpretation links to source events. A narrative that
 * cannot be traced to events is an unfalsifiable claim.
 */
export {
  METRIC_REGISTRY,
  autonomyFlags,
  checkRegistry,
  computeMetrics,
  productiveTimeScore,
  type MetricValue,
  type RunSnapshot,
} from "./metrics.js";

export {
  detectTurningPoints,
  generateReport,
  type ReportInput,
  type TurningPoint,
} from "./report.js";
