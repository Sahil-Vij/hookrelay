import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export interface NewEvent {
  source: string;
  idempotencyKey: string | undefined;
  contentType: string | undefined;
  body: Buffer;
}

export interface Store {
  /** Saves an event once. Returns the existing event if this key was already seen for the source. */
  saveEvent(event: NewEvent): { id: number; duplicate: boolean };
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
    )
  `);
  // Relies on the UNIQUE constraint rather than check-then-insert, so concurrent retries can't both win.
  const insert = db.prepare(`
    INSERT INTO events (source, idempotency_key, content_type, body) VALUES (?, ?, ?, ?)
    ON CONFLICT (source, idempotency_key) DO NOTHING
    RETURNING id
  `);
  const find = db.prepare("SELECT id FROM events WHERE source = ? AND idempotency_key = ?");

  return {
    saveEvent({ source, idempotencyKey, contentType, body }) {
      // Without a sender-supplied key, identical bodies count as the same event.
      const key = idempotencyKey ?? `sha256:${createHash("sha256").update(body).digest("hex")}`;
      const inserted = insert.get(source, key, contentType ?? null, body) as { id: number } | undefined;
      if (inserted) return { id: Number(inserted.id), duplicate: false };
      const existing = find.get(source, key) as { id: number };
      return { id: Number(existing.id), duplicate: true };
    },
    close: () => db.close(),
  };
}
