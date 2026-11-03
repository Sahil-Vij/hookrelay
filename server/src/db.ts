import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface NewEvent {
  source: string;
  idempotencyKey: string | undefined;
  contentType: string | undefined;
  body: Buffer;
  /** Where to forward this event. Without one, the event is only stored. */
  targetUrl?: string;
}

export interface DueDelivery {
  id: number;
  eventId: number;
  source: string;
  targetUrl: string;
  attempts: number;
  contentType: string | null;
  body: Buffer;
}

export interface DeliveryState {
  status: "pending" | "delivered" | "failed";
  attempts: number;
  nextAttemptAt: number;
  lastStatusCode: number | null;
  lastError: string | null;
}

export interface AttemptResult {
  attempts: number;
  statusCode: number | null;
  error: string | null;
}

export interface Store {
  /** Saves an event once. Returns the existing event if this key was already seen for the source. */
  saveEvent(event: NewEvent): { id: number; duplicate: boolean };
  dueDeliveries(now: number, limit: number): DueDelivery[];
  markDelivered(id: number, result: AttemptResult): void;
  markRetry(id: number, result: AttemptResult, nextAttemptAt: number): void;
  markFailed(id: number, result: AttemptResult): void;
  getDelivery(eventId: number): DeliveryState | undefined;
  close(): void;
}

export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      content_type TEXT,
      body BLOB NOT NULL,
      received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (source, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL UNIQUE REFERENCES events (id),
      target_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_status_code INTEGER,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries (status, next_attempt_at);
  `);
  // Relies on the UNIQUE constraint rather than check-then-insert, so concurrent retries can't both win.
  const insertEvent = db.prepare(`
    INSERT INTO events (source, idempotency_key, content_type, body) VALUES (?, ?, ?, ?)
    ON CONFLICT (source, idempotency_key) DO NOTHING
    RETURNING id
  `);
  const findEvent = db.prepare("SELECT id FROM events WHERE source = ? AND idempotency_key = ?");
  const insertDelivery = db.prepare("INSERT INTO deliveries (event_id, target_url) VALUES (?, ?)");
  const selectDue = db.prepare(`
    SELECT d.id, d.event_id AS eventId, e.source, d.target_url AS targetUrl, d.attempts,
           e.content_type AS contentType, e.body
    FROM deliveries d JOIN events e ON e.id = d.event_id
    WHERE d.status = 'pending' AND d.next_attempt_at <= ?
    ORDER BY d.next_attempt_at, d.id
    LIMIT ?
  `);
  const updateDelivery = db.prepare(`
    UPDATE deliveries
    SET status = ?, attempts = ?, next_attempt_at = ?, last_status_code = ?, last_error = ?
    WHERE id = ?
  `);
  const selectDelivery = db.prepare(`
    SELECT status, attempts, next_attempt_at AS nextAttemptAt,
           last_status_code AS lastStatusCode, last_error AS lastError
    FROM deliveries WHERE event_id = ?
  `);

  const finish = (status: DeliveryState["status"], id: number, result: AttemptResult, nextAttemptAt = 0) => {
    updateDelivery.run(status, result.attempts, nextAttemptAt, result.statusCode, result.error, id);
  };

  return {
    saveEvent({ source, idempotencyKey, contentType, body, targetUrl }) {
      // Without a sender-supplied key, identical bodies count as the same event.
      const key = idempotencyKey ?? `sha256:${createHash("sha256").update(body).digest("hex")}`;
      // One transaction, so a stored event can never be left without its delivery.
      db.exec("BEGIN IMMEDIATE");
      try {
        const inserted = insertEvent.get(source, key, contentType ?? null, body) as { id: number } | undefined;
        const id = Number(inserted ? inserted.id : (findEvent.get(source, key) as { id: number }).id);
        if (inserted && targetUrl) insertDelivery.run(id, targetUrl);
        db.exec("COMMIT");
        return { id, duplicate: !inserted };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    dueDeliveries(now, limit) {
      const rows = selectDue.all(now, limit) as unknown as (Omit<DueDelivery, "body"> & { body: Uint8Array })[];
      return rows.map((row) => ({ ...row, body: Buffer.from(row.body) }));
    },
    markDelivered: (id, result) => finish("delivered", id, result),
    markRetry: (id, result, nextAttemptAt) => finish("pending", id, result, nextAttemptAt),
    markFailed: (id, result) => finish("failed", id, result),
    getDelivery: (eventId) => selectDelivery.get(eventId) as DeliveryState | undefined,
    close: () => db.close(),
  };
}
