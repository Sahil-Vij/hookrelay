import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openStore } from "../src/db.ts";

const event = (idempotencyKey: string, signature?: string) => ({
  source: "demo",
  idempotencyKey,
  contentType: "application/json",
  body: Buffer.from("{}"),
  signature,
});

test("opens a database made before signatures were stored, keeping its events", () => {
  const dir = mkdtempSync(join(tmpdir(), "hookrelay-"));
  const path = join(dir, "old.db");
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY, source TEXT NOT NULL, idempotency_key TEXT NOT NULL, content_type TEXT,
        body BLOB NOT NULL, received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (source, idempotency_key)
      );
      INSERT INTO events (source, idempotency_key, body) VALUES ('demo', 'old-1', x'7b7d'), ('demo', 'old-2', x'7b7d');
    `);
    old.close();

    const store = openStore(path);
    assert.deepEqual(store.saveEvent(event("old-1", "sha256=new")), { id: 1, duplicate: true });
    assert.deepEqual(store.saveEvent(event("new-1", "sha256=new")), { id: 3, duplicate: false });
    assert.deepEqual(store.saveEvent(event("new-2", "sha256=new")), { id: 3, duplicate: true });
    store.close();
    // Opening again must not try to add the column twice.
    openStore(path).close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("events saved without a signature never collide on it", () => {
  const store = openStore(":memory:");
  assert.equal(store.saveEvent(event("a")).duplicate, false);
  assert.equal(store.saveEvent(event("b")).duplicate, false);
  store.close();
});
