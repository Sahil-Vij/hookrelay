import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApp } from "../src/app.ts";
import { openStore } from "../src/db.ts";
import { verifySignature } from "../src/signature.ts";
import { createDeliveryWorker } from "../src/worker.ts";

const API_KEY = "test-api-key";
const SECRET = "test-secret";
const OLD_TARGET = "https://old.example/hook";
const TARGET = "https://app.example/hook";

const store = openStore(":memory:");
const targets = new Map([["shop", TARGET]]);
let server: Server;
let base: string;

before(async () => {
  server = createApp({ store, secrets: new Map(), targets, apiKey: API_KEY }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  store.close();
});

let keys = 0;
function save(source: string, targetUrl?: string) {
  keys += 1;
  return store.saveEvent({
    source,
    idempotencyKey: `evt-${keys}`,
    contentType: "application/json",
    body: Buffer.from(`{"n":${keys}}`),
    targetUrl,
  }).id;
}

/** Saves an event and finishes its first delivery the way the worker would. */
function saveFinished(outcome: "delivered" | "failed") {
  const id = save("shop", TARGET);
  const delivery = store.dueDeliveries(Number.MAX_SAFE_INTEGER, 1000).find((d) => d.eventId === id);
  assert.ok(delivery);
  if (outcome === "delivered") store.markDelivered(delivery.id, { attempts: 1, statusCode: 200, error: null });
  else store.markFailed(delivery.id, { attempts: 12, statusCode: 500, error: "HTTP 500" });
  return id;
}

const replay = (id: number | string, authorization = `Bearer ${API_KEY}`) =>
  fetch(`${base}/api/events/${id}/replay`, { method: "POST", headers: { authorization } });

test("needs the API key and doesn't change anything without it", async () => {
  const id = saveFinished("delivered");
  for (const authorization of ["", "Bearer wrong"]) {
    assert.equal((await replay(id, authorization)).status, 401);
  }
  assert.equal(store.getDelivery(id)?.status, "delivered");
});

test("requeues a failed event with a fresh retry budget", async () => {
  const id = saveFinished("failed");
  const res = await replay(id);
  assert.equal(res.status, 202);
  const event = await res.json();
  assert.equal(event.id, id);
  assert.equal("body" in event, false);
  assert.deepEqual(event.delivery, {
    status: "pending",
    attempts: 0,
    nextAttemptAt: null,
    lastStatusCode: null,
    lastError: null,
  });
});

test("the worker sends a replayed event again, with the same id and bytes", async () => {
  const id = saveFinished("delivered");
  const sent: { url: string; headers: Headers; body: Buffer }[] = [];
  const worker = createDeliveryWorker({
    store,
    secrets: new Map([["shop", SECRET]]),
    fetch: async (url, init) => {
      sent.push({ url: String(url), headers: new Headers(init?.headers), body: Buffer.from(init?.body as Uint8Array) });
      return new Response(null, { status: 200 });
    },
  });

  assert.equal((await replay(id)).status, 202);
  await worker.runOnce();

  const mine = sent.filter((s) => s.headers.get("x-hookrelay-event-id") === String(id));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].url, TARGET);
  assert.equal(mine[0].body.toString(), store.getEvent(id)?.body.toString());
  assert.ok(verifySignature(mine[0].body, SECRET, mine[0].headers.get("x-hookrelay-signature") ?? undefined));
  assert.equal(store.getDelivery(id)?.status, "delivered");
});

test("refuses while a delivery is still pending", async () => {
  const id = save("shop", TARGET);
  const res = await replay(id);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "already_pending" });
});

test("concurrent replays queue the event only once", async () => {
  const id = saveFinished("failed");
  const statuses = await Promise.all(Array.from({ length: 10 }, () => replay(id).then((r) => r.status)));
  assert.equal(statuses.filter((s) => s === 202).length, 1);
  assert.equal(statuses.filter((s) => s === 409).length, 9);
});

test("sends to the source's current target, not the one it had when received", async () => {
  const id = save("shop", OLD_TARGET);
  const delivery = store.dueDeliveries(Number.MAX_SAFE_INTEGER, 1000).find((d) => d.eventId === id);
  assert.ok(delivery);
  store.markFailed(delivery.id, { attempts: 12, statusCode: null, error: "fetch failed" });

  assert.equal((await replay(id)).status, 202);
  const due = store.dueDeliveries(Number.MAX_SAFE_INTEGER, 1000).find((d) => d.eventId === id);
  assert.equal(due?.targetUrl, TARGET);
});

test("delivers an event that was stored before its source had a target", async () => {
  const id = save("shop");
  assert.equal(store.getDelivery(id), undefined);
  assert.equal((await replay(id)).status, 202);
  assert.equal(store.getDelivery(id)?.status, "pending");
});

test("refuses when the source has no target", async () => {
  const id = save("crm");
  const res = await replay(id);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "no_target" });
  assert.equal(store.getDelivery(id), undefined);
});

test("returns 404 for a missing event or a bad id", async () => {
  for (const id of ["999999", "abc", "0", "-1"]) {
    assert.equal((await replay(id)).status, 404, id);
  }
});

test("only POST replays", async () => {
  const id = saveFinished("delivered");
  const res = await fetch(`${base}/api/events/${id}/replay`, { headers: { authorization: `Bearer ${API_KEY}` } });
  assert.equal(res.status, 404);
  assert.equal(store.getDelivery(id)?.status, "delivered");
});
