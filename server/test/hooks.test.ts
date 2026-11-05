import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createApp } from "../src/app.ts";
import { openStore } from "../src/db.ts";
import { sign } from "../src/signature.ts";

const SECRET = "test-secret";
const store = openStore(":memory:");
let server: Server;
let base: string;

before(async () => {
  server = createApp({ store, secrets: new Map([["demo", SECRET]]), apiKey: "test-key" }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  store.close();
});

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", body, headers });
const signed = (body: string, headers: Record<string, string> = {}, source = "demo") =>
  post(`/hooks/${source}`, body, {
    "content-type": "application/json",
    "x-hookrelay-signature": sign(Buffer.from(body), SECRET),
    ...headers,
  });

test("health check responds", async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("accepts a correctly signed event", async () => {
  const res = await signed('{"order":1}');
  assert.equal(res.status, 202);
  assert.equal((await res.json()).duplicate, false);
});

test("rejects a missing signature", async () => {
  assert.equal((await post("/hooks/demo", "{}")).status, 401);
});

test("rejects a signature of a different length without throwing", async () => {
  assert.equal((await post("/hooks/demo", "{}", { "x-hookrelay-signature": "sha256=abc" })).status, 401);
});

test("rejects a body changed after signing", async () => {
  const res = await post("/hooks/demo", '{"amount":999}', {
    "x-hookrelay-signature": sign(Buffer.from('{"amount":1}'), SECRET),
  });
  assert.equal(res.status, 401);
});

test("verifies the exact bytes, not re-serialised JSON", async () => {
  assert.equal((await signed('{ "spaced" :   true }')).status, 202);
});

test("returns 404 for an unknown source, including object prototype names", async () => {
  for (const source of ["nope", "__proto__", "constructor"]) {
    assert.equal((await signed("{}", {}, source)).status, 404, source);
  }
});

test("the same idempotency key is stored once", async () => {
  const headers = { "idempotency-key": "evt-1" };
  const first = await (await signed('{"try":1}', headers)).json();
  const res = await signed('{"try":2}', headers);
  const second = await res.json();
  assert.equal(res.status, 200);
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);
});

test("without a key, identical bodies dedupe and different bodies don't", async () => {
  const first = await (await signed('{"hash":1}')).json();
  assert.equal((await (await signed('{"hash":1}')).json()).id, first.id);
  assert.notEqual((await (await signed('{"hash":2}')).json()).id, first.id);
});

test("concurrent deliveries of one event create a single row", async () => {
  const results = await Promise.all(
    Array.from({ length: 10 }, () => signed("{}", { "idempotency-key": "evt-race" }).then((r) => r.json())),
  );
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal(results.filter((r) => !r.duplicate).length, 1);
});

test("rejects bodies over 1 MB", async () => {
  assert.equal((await signed("x".repeat(1024 * 1024 + 1))).status, 413);
});
