import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApp } from "../src/app.ts";
import { openStore } from "../src/db.ts";

const API_KEY = "test-api-key";
const TARGET = "http://localhost:5000/webhook";
const BINARY = Buffer.from([0xff, 0xfe, 0x00, 0x7f]);
const NEXT_ATTEMPT_AT = Date.UTC(2030, 0, 1);

const store = openStore(":memory:");
let server: Server;
let base: string;
const ids: Record<string, number> = {};

function seed(name: string, source: string, body: string | Buffer, targetUrl?: string) {
  ids[name] = store.saveEvent({
    source,
    idempotencyKey: name,
    contentType: typeof body === "string" ? "application/json" : "application/octet-stream",
    body: Buffer.from(body),
    targetUrl,
  }).id;
}

before(async () => {
  seed("stored", "demo", '{"secret":"customer data"}');
  seed("binary", "demo", BINARY);
  seed("empty", "demo", "");
  seed("delivered", "demo", '{"n":1}', TARGET);
  seed("failed", "shop", '{"n":2}', TARGET);
  seed("retrying", "demo", '{"n":3}', TARGET);
  seed("due", "demo", '{"n":4}', TARGET);

  const deliveryId = (eventId: number) => {
    const due = store.dueDeliveries(Date.now(), 10).find((d) => d.eventId === eventId);
    return (due as { id: number }).id;
  };
  store.markDelivered(deliveryId(ids.delivered), { attempts: 1, statusCode: 200, error: null });
  store.markFailed(deliveryId(ids.failed), { attempts: 12, statusCode: 500, error: "HTTP 500" });
  store.markRetry(deliveryId(ids.retrying), { attempts: 2, statusCode: null, error: "timeout" }, NEXT_ATTEMPT_AT);

  server = createApp({ store, secrets: new Map(), apiKey: API_KEY }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  store.close();
});

const api = (path: string, authorization = `Bearer ${API_KEY}`) =>
  fetch(`${base}/api${path}`, { headers: { authorization } });
const list = async (query = "") => (await (await api(`/events${query}`)).json()) as {
  events: { id: number; source: string; body?: string; byteLength: number }[];
  nextCursor: number | null;
};

test("rejects a missing, wrong or malformed API key on every route", async () => {
  const paths = ["/events", `/events/${ids.stored}`, "/nope"];
  const headers: Record<string, string>[] = [
    {},
    { authorization: "Bearer wrong" },
    { authorization: `Bearer ${API_KEY}x` },
    { authorization: `Basic ${API_KEY}` },
    { authorization: API_KEY },
    { authorization: "Bearer " },
  ];
  for (const path of paths) {
    for (const h of headers) {
      const res = await fetch(`${base}/api${path}`, { headers: h });
      assert.equal(res.status, 401, `${path} ${JSON.stringify(h)}`);
      assert.equal(res.headers.get("www-authenticate"), "Bearer");
      assert.ok(!(await res.text()).includes("customer data"));
    }
  }
});

test("refuses to start with an empty API key", () => {
  assert.throws(() => createApp({ store, secrets: new Map(), apiKey: "" }), /apiKey/);
});

test("responses are never cached", async () => {
  assert.equal((await api("/events")).headers.get("cache-control"), "no-store");
  assert.equal((await api("/events", "Bearer wrong")).headers.get("cache-control"), "no-store");
});

test("lists events newest first, without bodies", async () => {
  const { events, nextCursor } = await list();
  assert.deepEqual(
    events.map((e) => e.id),
    Object.values(ids).sort((a, b) => b - a),
  );
  assert.equal(nextCursor, null);
  assert.ok(events.every((e) => !("body" in e)));
  assert.equal(events.find((e) => e.id === ids.binary)?.byteLength, BINARY.length);
});

test("pages through every event exactly once", async () => {
  const seen: number[] = [];
  let cursor: number | null = null;
  let pages = 0;
  do {
    const page: Awaited<ReturnType<typeof list>> = await list(`?limit=3${cursor ? `&before=${cursor}` : ""}`);
    assert.ok(page.events.length <= 3);
    seen.push(...page.events.map((e) => e.id));
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor !== null);
  assert.equal(pages, 3);
  assert.deepEqual(
    seen,
    Object.values(ids).sort((a, b) => b - a),
  );
});

test("a page that exactly fills the limit has no next cursor", async () => {
  const { nextCursor } = await list(`?limit=${Object.keys(ids).length}`);
  assert.equal(nextCursor, null);
});

test("filters by source and delivery status", async () => {
  assert.deepEqual(
    (await list("?source=shop")).events.map((e) => e.id),
    [ids.failed],
  );
  assert.deepEqual(
    (await list("?status=delivered")).events.map((e) => e.id),
    [ids.delivered],
  );
  assert.deepEqual(
    (await list("?status=pending")).events.map((e) => e.id),
    [ids.due, ids.retrying],
  );
  assert.deepEqual((await list("?source=shop&status=delivered")).events, []);
  assert.deepEqual((await list("?source=nope")).events, []);
});

test("rejects invalid query parameters", async () => {
  const queries = [
    "limit=0",
    "limit=101",
    "limit=-1",
    "limit=abc",
    "limit=1.5",
    "limit=",
    "limit=1&limit=2",
    "before=0",
    "before=abc",
    "before=99999999999999999999",
    "status=done",
    "status=pending&status=failed",
    "source=a&source=b",
  ];
  for (const query of queries) {
    const res = await api(`/events?${query}`);
    assert.equal(res.status, 400, query);
    assert.deepEqual(await res.json(), { error: "invalid_query" });
  }
});

test("treats SQL in a filter as plain text", async () => {
  assert.deepEqual((await list(`?source=${encodeURIComponent("' OR 1=1 --")}`)).events, []);
});

test("reads a text event with its body", async () => {
  const event = await (await api(`/events/${ids.stored}`)).json();
  assert.equal(event.body, '{"secret":"customer data"}');
  assert.equal(event.bodyEncoding, "utf8");
  assert.equal(event.source, "demo");
  assert.equal(event.idempotencyKey, "stored");
  assert.equal(event.contentType, "application/json");
  assert.match(event.receivedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(event.delivery, null);
});

test("returns bytes that aren't valid UTF-8 as base64, unchanged", async () => {
  const event = await (await api(`/events/${ids.binary}`)).json();
  assert.equal(event.bodyEncoding, "base64");
  assert.deepEqual(Buffer.from(event.body, "base64"), BINARY);
});

test("reads an event with an empty body", async () => {
  const event = await (await api(`/events/${ids.empty}`)).json();
  assert.equal(event.body, "");
  assert.equal(event.byteLength, 0);
});

test("reports delivery state", async () => {
  const delivery = async (name: string) => (await (await api(`/events/${ids[name]}`)).json()).delivery;
  assert.deepEqual(await delivery("delivered"), {
    status: "delivered",
    attempts: 1,
    nextAttemptAt: null,
    lastStatusCode: 200,
    lastError: null,
  });
  assert.deepEqual(await delivery("failed"), {
    status: "failed",
    attempts: 12,
    nextAttemptAt: null,
    lastStatusCode: 500,
    lastError: "HTTP 500",
  });
  assert.deepEqual(await delivery("retrying"), {
    status: "pending",
    attempts: 2,
    nextAttemptAt: new Date(NEXT_ATTEMPT_AT).toISOString(),
    lastStatusCode: null,
    lastError: "timeout",
  });
  assert.deepEqual(await delivery("due"), {
    status: "pending",
    attempts: 0,
    nextAttemptAt: null,
    lastStatusCode: null,
    lastError: null,
  });
});

test("returns 404 for a missing event or a bad id", async () => {
  for (const id of ["999999", "abc", "0", "-1", "1.5", "99999999999999999999"]) {
    const res = await api(`/events/${id}`);
    assert.equal(res.status, 404, id);
    assert.deepEqual(await res.json(), { error: "not_found" });
  }
});

test("returns a JSON 404 for an unknown route once authenticated", async () => {
  const res = await api("/nope");
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not_found" });
});
