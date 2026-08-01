/**
 * State projection.
 *
 * The event log is authoritative. Queryable state is derived (§34.1). Nothing in
 * this package may be written to directly — if a projection disagrees with the
 * log, the log is right and the projection is a bug.
 *
 * Projectors are pure and versioned. Purity is what makes replay meaningful: the
 * same events must produce the same state on a different machine a year later,
 * or the §6.9 replay invariant is a slogan.
 *
 * Spec: §34.
 */
import type { RecordedEvent } from "@freeq-foundry/protocol";

/**
 * A pure fold over the event log.
 *
 * `apply` MUST NOT perform I/O, read a clock, or consult randomness. Anything
 * time-dependent comes from the event's own `wallTime` or `logicalTime`.
 */
export interface Projector<S> {
  readonly id: string;
  /**
   * Bumped when `apply` changes in a way that alters output for existing events.
   *
   * Recorded in snapshots so a stale snapshot is detected rather than silently
   * trusted (§34.3).
   */
  readonly version: number;
  initialState(): S;
  apply(state: S, event: RecordedEvent): S;
}

/** A projection's state at a known position in the log. */
export interface Snapshot<S> {
  readonly projectorId: string;
  readonly projectorVersion: number;
  readonly runId: string;
  /** Logical time of the last event applied, or -1 for an empty projection. */
  readonly logicalTime: number;
  readonly state: S;
}

/** Fold a projector over events, from scratch. */
export function project<S>(
  projector: Projector<S>,
  events: Iterable<RecordedEvent>,
  runId: string,
): Snapshot<S> {
  let state = projector.initialState();
  let logicalTime = -1;

  for (const event of events) {
    state = projector.apply(state, event);
    logicalTime = event.logicalTime;
  }

  return {
    projectorId: projector.id,
    projectorVersion: projector.version,
    runId,
    logicalTime,
    state,
  };
}

/** Fold a projector over an async event source. */
export async function projectAsync<S>(
  projector: Projector<S>,
  events: AsyncIterable<RecordedEvent>,
  runId: string,
): Promise<Snapshot<S>> {
  let state = projector.initialState();
  let logicalTime = -1;

  for await (const event of events) {
    state = projector.apply(state, event);
    logicaltimeGuard(logicalTime, event.logicalTime);
    logicalTime = event.logicalTime;
  }

  return {
    projectorId: projector.id,
    projectorVersion: projector.version,
    runId,
    logicalTime,
    state,
  };
}

function logicaltimeGuard(previous: number, next: number): void {
  if (next <= previous) {
    // Out-of-order events would silently produce wrong state, and a projection
    // that is quietly wrong is worse than one that fails.
    throw new Error(
      `projection received logicalTime ${next} after ${previous}; events must arrive in canonical order`,
    );
  }
}

/**
 * Resume a projection from a snapshot.
 *
 * Refuses a snapshot from a different projector version: applying new logic to
 * state built by old logic yields something that is neither (§34.3).
 */
export function resume<S>(
  projector: Projector<S>,
  snapshot: Snapshot<S>,
  events: Iterable<RecordedEvent>,
): Snapshot<S> {
  if (snapshot.projectorId !== projector.id) {
    throw new Error(
      `snapshot is for projector ${snapshot.projectorId}, not ${projector.id}`,
    );
  }
  if (snapshot.projectorVersion !== projector.version) {
    throw new Error(
      `snapshot is version ${snapshot.projectorVersion}, projector is version ` +
        `${projector.version}; rebuild from the log rather than resuming`,
    );
  }

  let state = snapshot.state;
  let logicalTime = snapshot.logicalTime;

  for (const event of events) {
    if (event.logicalTime <= snapshot.logicalTime) continue;
    state = projector.apply(state, event);
    logicalTime = event.logicalTime;
  }

  return { ...snapshot, state, logicalTime };
}

/**
 * Run several projectors over one pass of the log.
 *
 * Reading the log once matters at scale, but the stronger reason is consistency:
 * separate passes could observe different suffixes and produce a set of
 * projections that never simultaneously existed.
 */
export function projectAll(
  projectors: readonly Projector<unknown>[],
  events: Iterable<RecordedEvent>,
  runId: string,
): Map<string, Snapshot<unknown>> {
  const states = new Map<string, unknown>();
  for (const projector of projectors) {
    states.set(projector.id, projector.initialState());
  }

  let logicalTime = -1;
  for (const event of events) {
    for (const projector of projectors) {
      states.set(projector.id, projector.apply(states.get(projector.id), event));
    }
    logicalTime = event.logicalTime;
  }

  const snapshots = new Map<string, Snapshot<unknown>>();
  for (const projector of projectors) {
    snapshots.set(projector.id, {
      projectorId: projector.id,
      projectorVersion: projector.version,
      runId,
      logicalTime,
      state: states.get(projector.id),
    });
  }
  return snapshots;
}

/**
 * Wrap a projector so it only sees events it declares an interest in.
 *
 * Keeps each projector's `apply` free of a long `if` chain, and makes the
 * projector's inputs declarative — which is what §40.1 requires of metrics built
 * on them.
 */
export function forEventTypes<S>(
  projector: Projector<S>,
  eventTypes: readonly string[],
): Projector<S> {
  const wanted = new Set(eventTypes);
  return {
    id: projector.id,
    version: projector.version,
    initialState: () => projector.initialState(),
    apply: (state, event) =>
      wanted.has(event.eventType) ? projector.apply(state, event) : state,
  };
}
