/**
 * @freeq-foundry/gateway
 *
 * The only writer (§32.2). Enforces every §33.4 rejection before an event
 * reaches the store, acknowledges idempotently (§36.9), and filters
 * subscriptions by visibility (§33.7).
 */
export {
  Gateway,
  StaticAdmissionRegistry,
  canSee,
  type Acknowledgement,
  type Admission,
  type AdmissionRegistry,
  type GatewayOptions,
  type Rejection,
  type SubmitResult,
  type SubscribeOptions,
  type Viewer,
} from "./gateway.js";
