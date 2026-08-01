/**
 * SQLite event store.
 *
 * A run must outlive the process for anything to be observed after the fact, replayed
 * later, or published. ADR-0006 chose PostgreSQL for production and named SQLite as a
 * candidate third backend for self-contained datasets; that is what this is, and it
 * needs no infrastructure, which matters for a demo someone runs on a laptop.
 *
 * Two guarantees ADR-0006 said must be **structural** rather than conventional, and
 * are:
 *
 *   - `UNIQUE (run_id, actor_did, participant_sequence)` — application logic loses
 *     races, so the constraint lives in the schema.
 *   - No `UPDATE` or `DELETE` is issued anywhere, and triggers reject both. §35.3
 *     forbids mutating canonical events, and a convention is not an enforcement.
 *
 * Uses `node:sqlite`, available from Node 22. Absent it, the constructor says so
 * rather than failing obscurely later.
 *
 * Spec: §35.2, §35.3. Decision: ADR-0006.
 */
import {
  GENESIS_HASH,
  ProtocolError,
  ProtocolErrorCode,
  SequenceTracker,
  canonicalizeToBytes,
  positionEvent,
  recordEvent,
  verifyChain as verifyChainOf,
  verifyEvent,
  type AttributedEvent,
  type ChainVerification,
  type Digest,
  type RecordedEvent,
} from "@freeq-foundry/protocol";
import type { KeyObject } from "node:crypto";
import type {
  AppendResult,
  ChainHead,
  EventStore,
  ReadOptions,
  RunRegistration,
  VerifyOptions,
} from "./types.js";

const MAX_EVENT_BYTES = 1024 * 1024;

/** Minimal surface of `node:sqlite`, so the dependency stays inspectable. */
interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/**
 * Schema.
 *
 * `references` is a SQL reserved word, so the column is `event_references` while the
 * wire field keeps the §33.1 name. ADR-0006 recorded this because it is exactly the
 * kind of silent divergence that costs an afternoon.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  run_id       TEXT PRIMARY KEY,
  recorder_did TEXT NOT NULL,
  closed       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  event_id             TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL REFERENCES runs(run_id),
  event_type           TEXT NOT NULL,
  schema_version       INTEGER NOT NULL,
  actor_did            TEXT NOT NULL,
  participant_type     TEXT NOT NULL,
  participant_sequence INTEGER NOT NULL,
  logical_time         INTEGER NOT NULL,
  wall_time            TEXT NOT NULL,
  payload              TEXT NOT NULL,
  visibility           TEXT NOT NULL,
  provenance           TEXT NOT NULL,
  causation_id         TEXT,
  correlation_id       TEXT,
  event_references     TEXT NOT NULL,
  previous_event_hash  TEXT NOT NULL,
  event_hash           TEXT NOT NULL,
  signature            TEXT NOT NULL,
  recorder_signature   TEXT NOT NULL,
  UNIQUE (run_id, logical_time),
  UNIQUE (run_id, actor_did, participant_sequence)
);

CREATE INDEX IF NOT EXISTS events_run_logical ON events(run_id, logical_time);
CREATE INDEX IF NOT EXISTS events_run_actor ON events(run_id, actor_did);

-- §35.3 made structural. Corrections happen through new events, so nothing in this
-- process has any business updating or deleting one.
CREATE TRIGGER IF NOT EXISTS events_immutable_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'canonical events are immutable (spec 35.3)');
END;

CREATE TRIGGER IF NOT EXISTS events_immutable_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'canonical events are immutable (spec 35.3)');
END;
`;

export interface SqliteEventStoreOptions {
  /** File path, or `:memory:`. */
  readonly path: string;
  readonly recorderDid: string;
  readonly recorderPrivateKey: KeyObject;
}

export class SqliteEventStore implements EventStore {
  readonly #db: SqliteDatabase;
  readonly #recorderDid: string;
  readonly #recorderPrivateKey: KeyObject;
  readonly #locks = new Map<string, Promise<unknown>>();

  private constructor(
    db: SqliteDatabase,
    recorderDid: string,
    recorderPrivateKey: KeyObject,
  ) {
    this.#db = db;
    this.#recorderDid = recorderDid;
    this.#recorderPrivateKey = recorderPrivateKey;
    this.#db.exec(SCHEMA);
  }

  /**
   * Open a store.
   *
   * Async because `node:sqlite` must be imported dynamically: it is unavailable before
   * Node 22, and a static import would break the whole package on Node 20 rather than
   * only this backend.
   */
  static async open(options: SqliteEventStoreOptions): Promise<SqliteEventStore> {
    let module: { DatabaseSync: new (path: string) => SqliteDatabase };
    try {
      module = (await import("node:sqlite")) as unknown as {
        DatabaseSync: new (path: string) => SqliteDatabase;
      };
    } catch {
      throw new Error(
        "node:sqlite is unavailable. It requires Node 22 or later; use InMemoryEventStore, " +
          "or the PostgreSQL backend when it exists.",
      );
    }
    return new SqliteEventStore(
      new module.DatabaseSync(options.path),
      options.recorderDid,
      options.recorderPrivateKey,
    );
  }

  get recorderDid(): string {
    return this.#recorderDid;
  }

  close(): void {
    this.#db.close();
  }

  async registerRun(registration: RunRegistration): Promise<void> {
    if (registration.recorderDid !== this.#recorderDid) {
      throw new ProtocolError(
        ProtocolErrorCode.SIGNER_MISMATCH,
        `run ${registration.runId} declares recorder ${registration.recorderDid}, ` +
          `but this store records as ${this.#recorderDid}`,
      );
    }
    const existing = this.#db
      .prepare("SELECT run_id FROM runs WHERE run_id = ?")
      .get(registration.runId);
    if (existing !== undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.MALFORMED_EVENT,
        `run ${registration.runId} is already registered`,
      );
    }
    this.#db
      .prepare("INSERT INTO runs (run_id, recorder_did, closed) VALUES (?, ?, 0)")
      .run(registration.runId, registration.recorderDid);
  }

  async closeRun(runId: string): Promise<void> {
    const changed = this.#db
      .prepare("UPDATE runs SET closed = 1 WHERE run_id = ?")
      .run(runId);
    if (Number(changed.changes) === 0) {
      throw new ProtocolError(
        ProtocolErrorCode.UNKNOWN_RUN,
        `run ${runId} is not registered`,
      );
    }
  }

  append(event: AttributedEvent): Promise<AppendResult> {
    return this.#serialized(event.runId, () => this.#appendNow(event));
  }

  appendBatch(events: readonly AttributedEvent[]): Promise<readonly AppendResult[]> {
    if (events.length === 0) return Promise.resolve([]);
    const runIds = new Set(events.map((event) => event.runId));
    if (runIds.size > 1) {
      return Promise.resolve([
        {
          accepted: false as const,
          code: ProtocolErrorCode.RUN_MISMATCH,
          message: `a batch must target one run, found ${runIds.size}`,
        },
      ]);
    }

    return this.#serialized(events[0]?.runId as string, () => {
      // A real transaction, so all-or-nothing does not depend on my rollback logic
      // being correct.
      this.#db.exec("BEGIN");
      const results: AppendResult[] = [];
      for (const event of events) {
        const result = this.#appendNow(event);
        results.push(result);
        if (!result.accepted) {
          this.#db.exec("ROLLBACK");
          return [result];
        }
      }
      this.#db.exec("COMMIT");
      return results;
    });
  }

  #appendNow(event: AttributedEvent): AppendResult {
    const run = this.#db
      .prepare("SELECT closed FROM runs WHERE run_id = ?")
      .get(event.runId);
    if (run === undefined) {
      return reject(ProtocolErrorCode.UNKNOWN_RUN, `run ${event.runId} is not registered`);
    }
    if (Number(run["closed"]) === 1) {
      return reject(
        ProtocolErrorCode.RUN_CLOSED,
        `run ${event.runId} is closed to further appends`,
      );
    }

    const existing = this.#db
      .prepare("SELECT * FROM events WHERE event_id = ?")
      .get(event.eventId);
    if (existing !== undefined) {
      return {
        accepted: false,
        code: ProtocolErrorCode.DUPLICATE_EVENT_ID,
        message: `eventId ${event.eventId} was already accepted at logicalTime ${String(existing["logical_time"])}`,
        existing: rowToEvent(existing),
      };
    }

    try {
      const bytes = canonicalizeToBytes(event as never);
      if (bytes.byteLength > MAX_EVENT_BYTES) {
        return reject(
          ProtocolErrorCode.SIZE_EXCEEDED,
          `event is ${bytes.byteLength} canonical bytes, limit is ${MAX_EVENT_BYTES}`,
        );
      }
    } catch (error) {
      return reject(
        error instanceof ProtocolError ? error.code : ProtocolErrorCode.MALFORMED_EVENT,
        error instanceof Error ? error.message : String(error),
      );
    }

    const tracker = new SequenceTracker([
      [event.actorDid, this.#latestSequence(event.runId, event.actorDid)],
    ]);
    const sequenceError = tracker.check(event.actorDid, event.participantSequence);
    if (sequenceError !== null) {
      return reject(sequenceError.code, sequenceError.message);
    }

    const head = this.#headRow(event.runId);
    const logicalTime = head === undefined ? 0 : Number(head["logical_time"]) + 1;
    const previousEventHash =
      head === undefined ? GENESIS_HASH : (head["event_hash"] as Digest);

    let recorded: RecordedEvent;
    try {
      recorded = recordEvent(
        positionEvent(event, { logicalTime, previousEventHash }),
        this.#recorderPrivateKey,
      );
    } catch (error) {
      return reject(
        error instanceof ProtocolError ? error.code : ProtocolErrorCode.MALFORMED_EVENT,
        error instanceof Error ? error.message : String(error),
      );
    }

    const verification = verifyEvent(recorded, { recorderDid: this.#recorderDid });
    if (!verification.valid) {
      const first = verification.errors[0] as ProtocolError;
      return reject(first.code, first.message);
    }

    try {
      this.#db
        .prepare(
          `INSERT INTO events (
             event_id, run_id, event_type, schema_version, actor_did, participant_type,
             participant_sequence, logical_time, wall_time, payload, visibility,
             provenance, causation_id, correlation_id, event_references,
             previous_event_hash, event_hash, signature, recorder_signature
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          recorded.eventId,
          recorded.runId,
          recorded.eventType,
          recorded.schemaVersion,
          recorded.actorDid,
          recorded.participantType,
          recorded.participantSequence,
          recorded.logicalTime,
          recorded.wallTime,
          JSON.stringify(recorded.payload),
          JSON.stringify(recorded.visibility),
          JSON.stringify(recorded.provenance),
          recorded.causationId ?? null,
          recorded.correlationId ?? null,
          JSON.stringify(recorded.references),
          recorded.previousEventHash,
          recorded.eventHash,
          recorded.signature,
          recorded.recorderSignature,
        );
    } catch (error) {
      // The unique constraints are the real defence against a race; a violation here
      // is the schema catching what application logic could not.
      return reject(
        ProtocolErrorCode.STALE_SEQUENCE,
        `database rejected the append: ${String(error)}`,
      );
    }

    return { accepted: true, event: recorded };
  }

  async *read(runId: string, options: ReadOptions = {}): AsyncIterable<RecordedEvent> {
    const clauses = ["run_id = ?"];
    const params: unknown[] = [runId];

    if (options.fromLogicalTime !== undefined) {
      clauses.push("logical_time >= ?");
      params.push(options.fromLogicalTime);
    }
    if (options.toLogicalTime !== undefined) {
      clauses.push("logical_time <= ?");
      params.push(options.toLogicalTime);
    }
    if (options.actorDid !== undefined) {
      clauses.push("actor_did = ?");
      params.push(options.actorDid);
    }

    const limit = options.limit === undefined ? "" : ` LIMIT ${Number(options.limit)}`;
    const rows = this.#db
      .prepare(
        `SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY logical_time ASC${limit}`,
      )
      .all(...params);

    for (const row of rows) yield rowToEvent(row);
  }

  async head(runId: string): Promise<ChainHead | undefined> {
    const row = this.#headRow(runId);
    if (row === undefined) return undefined;
    const count = this.#db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ?")
      .get(runId);
    return {
      runId,
      logicalTime: Number(row["logical_time"]),
      eventHash: row["event_hash"] as Digest,
      eventCount: Number(count?.["n"] ?? 0),
    };
  }

  async sequenceFor(runId: string, actorDid: string): Promise<number> {
    return this.#latestSequence(runId, actorDid);
  }

  async verifyChain(
    runId: string,
    options: VerifyOptions = {},
  ): Promise<ChainVerification> {
    const run = this.#db.prepare("SELECT run_id FROM runs WHERE run_id = ?").get(runId);
    if (run === undefined) {
      throw new ProtocolError(
        ProtocolErrorCode.UNKNOWN_RUN,
        `run ${runId} is not registered`,
      );
    }
    const events: RecordedEvent[] = [];
    for await (const event of this.read(runId)) events.push(event);

    return verifyChainOf(events, {
      runId,
      recorderDid: this.#recorderDid,
      verifySignatures: options.verifySignatures ?? true,
      stopOnFirst: options.stopOnFirst ?? false,
    });
  }

  /** Runs present in the file, for an observer listing a dataset. */
  runs(): readonly { readonly runId: string; readonly eventCount: number }[] {
    return this.#db
      .prepare(
        `SELECT r.run_id AS run_id, COUNT(e.event_id) AS n
         FROM runs r LEFT JOIN events e ON e.run_id = r.run_id
         GROUP BY r.run_id ORDER BY r.run_id`,
      )
      .all()
      .map((row) => ({
        runId: String(row["run_id"]),
        eventCount: Number(row["n"]),
      }));
  }

  #headRow(runId: string): Record<string, unknown> | undefined {
    return this.#db
      .prepare(
        "SELECT * FROM events WHERE run_id = ? ORDER BY logical_time DESC LIMIT 1",
      )
      .get(runId);
  }

  #latestSequence(runId: string, actorDid: string): number {
    const row = this.#db
      .prepare(
        "SELECT MAX(participant_sequence) AS s FROM events WHERE run_id = ? AND actor_did = ?",
      )
      .get(runId, actorDid);
    const value = row?.["s"];
    return value === null || value === undefined ? 0 : Number(value);
  }

  async #serialized<T>(runId: string, work: () => T): Promise<T> {
    const previous = this.#locks.get(runId) ?? Promise.resolve();
    const current = previous.then(work, work);
    this.#locks.set(
      runId,
      current.catch(() => undefined),
    );
    return current;
  }
}

function reject(code: ProtocolErrorCode, message: string): AppendResult {
  return { accepted: false, code, message };
}

/**
 * Rebuild an event from a row.
 *
 * Optional fields are omitted rather than set to null: ADR-0004 requires absent
 * rather than null, and a `null` here would change the canonical bytes and break the
 * event's own hash.
 */
function rowToEvent(row: Record<string, unknown>): RecordedEvent {
  const causationId = row["causation_id"];
  const correlationId = row["correlation_id"];
  return {
    eventId: String(row["event_id"]),
    runId: String(row["run_id"]),
    eventType: String(row["event_type"]),
    schemaVersion: Number(row["schema_version"]),
    actorDid: String(row["actor_did"]),
    participantType: String(row["participant_type"]) as RecordedEvent["participantType"],
    participantSequence: Number(row["participant_sequence"]),
    logicalTime: Number(row["logical_time"]),
    wallTime: String(row["wall_time"]),
    payload: JSON.parse(String(row["payload"])) as unknown,
    visibility: JSON.parse(String(row["visibility"])) as RecordedEvent["visibility"],
    provenance: JSON.parse(String(row["provenance"])) as RecordedEvent["provenance"],
    ...(causationId === null || causationId === undefined
      ? {}
      : { causationId: String(causationId) }),
    ...(correlationId === null || correlationId === undefined
      ? {}
      : { correlationId: String(correlationId) }),
    references: JSON.parse(String(row["event_references"])) as readonly string[],
    previousEventHash: String(row["previous_event_hash"]) as Digest,
    eventHash: String(row["event_hash"]) as Digest,
    signature: String(row["signature"]),
    recorderSignature: String(row["recorder_signature"]),
  };
}
