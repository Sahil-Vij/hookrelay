import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { openStore, type Store } from "../src/db.ts";
import { verifySignature } from "../src/signature.ts";
import { backoffDelay, createDeliveryWorker, type WorkerConfig } from "../src/worker.ts";

const SECRET = "test-secret";
const TARGET = "https://target.example/hook";
const BASE = 1_000;

function setup(fetch: typeof globalThis.fetch, overrides: Partial<WorkerConfig> = {}) {
  const store = openStore(":memory:");
  const clock = { time: 1_000_000 };
  const worker = createDeliveryWorker({
    store,
    secrets: new Map([["demo", SECRET]]),
    fetch,
    baseDelayMs: BASE,
    maxAttempts: 3,
    now: () => clock.time,
    random: () => 1,
    ...overrides,
  });
  return { store, clock, worker };
}

const save = (store: Store, key = "evt-1", targetUrl: string | undefined = TARGET) =>
  store.saveEvent({
    source: "demo",
    idempotencyKey: key,
    contentType: "application/json",
    body: Buffer.from('{"order":1}'),
    targetUrl,
  }).id;

const respond = (status: number) => async () => new Response(null, { status });

test("backoff doubles, respects the cap and applies jitter", () => {
  assert.equal(backoffDelay(1, 1000, 60_000, () => 1), 1000);
  assert.equal(backoffDelay(4, 1000, 60_000, () => 1), 8000);
  assert.equal(backoffDelay(30, 1000, 60_000, () => 1), 60_000);
  assert.equal(backoffDelay(4, 1000, 60_000, () => 0), 4000);
});

test("a 2xx response marks the delivery as delivered, and it isn't sent again", async () => {
  let calls = 0;
  const { store, worker } = setup(async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  });
  const id = save(store);

  await worker.runOnce();
  await worker.runOnce();

  assert.equal(calls, 1);
  const delivery = store.getDelivery(id);
  assert.equal(delivery?.status, "delivered");
  assert.equal(delivery?.attempts, 1);
  assert.equal(delivery?.lastStatusCode, 204);
  assert.equal(delivery?.lastError, null);
});

test("sends the exact bytes with a signature the receiver can verify", async () => {
  let init: RequestInit | undefined;
  const { store, worker } = setup(async (_url, requestInit) => {
    init = requestInit;
    return new Response(null, { status: 200 });
  });
  const id = save(store);

  await worker.runOnce();

  const headers = new Headers(init?.headers);
  const body = Buffer.from(init?.body as Uint8Array);
  assert.equal(body.toString(), '{"order":1}');
  const signed = {
    signature: headers.get("x-hookrelay-signature") ?? undefined,
    timestamp: headers.get("x-hookrelay-timestamp") ?? undefined,
  };
  assert.equal(signed.timestamp, "1000");
  assert.equal(verifySignature(body, SECRET, signed, 1_000_000), "valid");
  assert.equal(headers.get("x-hookrelay-event-id"), String(id));
  assert.equal(headers.get("x-hookrelay-attempt"), "1");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(init?.redirect, "manual");
});

test("a failure waits for the backoff before retrying", async () => {
  let calls = 0;
  const { store, clock, worker } = setup(async () => {
    calls += 1;
    return new Response(null, { status: calls === 1 ? 500 : 200 });
  });
  const id = save(store);

  await worker.runOnce();
  const afterFailure = store.getDelivery(id);
  assert.equal(afterFailure?.status, "pending");
  assert.equal(afterFailure?.lastError, "HTTP 500");
  assert.equal(afterFailure?.nextAttemptAt, clock.time + BASE);

  clock.time += BASE - 1;
  await worker.runOnce();
  assert.equal(calls, 1, "not due yet");

  clock.time += 1;
  await worker.runOnce();
  assert.equal(calls, 2);
  assert.equal(store.getDelivery(id)?.status, "delivered");
});

test("network errors are retried and recorded", async () => {
  const { store, worker } = setup(async () => {
    throw new Error("connection refused");
  });
  const id = save(store);

  await worker.runOnce();

  const delivery = store.getDelivery(id);
  assert.equal(delivery?.status, "pending");
  assert.equal(delivery?.lastStatusCode, null);
  assert.equal(delivery?.lastError, "connection refused");
});

test("a redirect counts as a failure", async () => {
  const { store, worker } = setup(respond(302));
  const id = save(store);
  await worker.runOnce();
  assert.equal(store.getDelivery(id)?.status, "pending");
});

test("gives up after the maximum attempts", async () => {
  let calls = 0;
  const { store, clock, worker } = setup(async () => {
    calls += 1;
    return new Response(null, { status: 503 });
  });
  const id = save(store);

  for (let i = 0; i < 6; i += 1) {
    await worker.runOnce();
    clock.time += 1_000_000;
  }

  assert.equal(calls, 3);
  const delivery = store.getDelivery(id);
  assert.equal(delivery?.status, "failed");
  assert.equal(delivery?.attempts, 3);
});

test("a duplicate event doesn't create a second delivery", async () => {
  let calls = 0;
  const { store, worker } = setup(async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  });
  const first = save(store);
  const second = save(store);
  assert.equal(first, second);

  await worker.runOnce();
  assert.equal(calls, 1);
});

test("an event without a target is only stored", async () => {
  let calls = 0;
  const { store, worker } = setup(async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  });
  const id = store.saveEvent({
    source: "demo",
    idempotencyKey: "no-target",
    contentType: undefined,
    body: Buffer.from("{}"),
  }).id;

  await worker.runOnce();

  assert.equal(calls, 0);
  assert.equal(store.getDelivery(id), undefined);
});

test("a missing secret fails the attempt without sending an unsigned request", async () => {
  let calls = 0;
  const { store, worker } = setup(
    async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    },
    { secrets: new Map() },
  );
  const id = save(store);

  await worker.runOnce();

  assert.equal(calls, 0);
  assert.match(store.getDelivery(id)?.lastError ?? "", /no secret/);
});

test("overlapping runs don't send an event twice", async () => {
  let calls = 0;
  const { store, worker } = setup(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(null, { status: 200 });
  });
  save(store);

  await Promise.all([worker.runOnce(), worker.runOnce(), worker.runOnce()]);
  assert.equal(calls, 1);
});

test("one bad event doesn't block the rest of the batch", async () => {
  const { store, worker } = setup(async (url) => new Response(null, { status: String(url).includes("bad") ? 500 : 200 }));
  const bad = save(store, "bad", "https://target.example/bad");
  const good = save(store, "good");

  await worker.runOnce();

  assert.equal(store.getDelivery(bad)?.status, "pending");
  assert.equal(store.getDelivery(good)?.status, "delivered");
});

test("start polls in the background and stop ends it", async () => {
  const { store, worker } = setup(respond(200), { pollIntervalMs: 5 });
  const id = save(store);

  worker.start();
  for (let i = 0; i < 100 && store.getDelivery(id)?.status !== "delivered"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await worker.stop();

  assert.equal(store.getDelivery(id)?.status, "delivered");
});

test("delivers over real HTTP to a receiver", async () => {
  let received = "";
  let signature: string | undefined;
  let timestamp: string | undefined;
  const target = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received = Buffer.concat(chunks).toString();
      signature = req.headers["x-hookrelay-signature"] as string;
      timestamp = req.headers["x-hookrelay-timestamp"] as string;
      res.writeHead(200).end("ok");
    });
  }).listen(0);
  await new Promise((resolve) => target.once("listening", resolve));

  try {
    const { store, worker } = setup(globalThis.fetch);
    const url = `http://127.0.0.1:${(target.address() as AddressInfo).port}/`;
    const id = save(store, "real-http", url);

    await worker.runOnce();

    assert.equal(store.getDelivery(id)?.status, "delivered");
    assert.equal(received, '{"order":1}');
    assert.equal(verifySignature(Buffer.from(received), SECRET, { signature, timestamp }, 1_000_000), "valid");
  } finally {
    target.close();
    target.closeAllConnections();
  }
});

test("each attempt is signed with the time it was sent, so late retries still verify", async () => {
  const sent: Headers[] = [];
  const { store, clock, worker } = setup(async (_url, init) => {
    sent.push(new Headers(init?.headers));
    return new Response(null, { status: sent.length === 1 ? 500 : 200 });
  });
  save(store);

  await worker.runOnce();
  clock.time += 2 * 3_600_000;
  await worker.runOnce();

  assert.equal(sent.length, 2);
  const [first, second] = sent.map((h) => h.get("x-hookrelay-timestamp"));
  assert.equal(first, "1000");
  assert.equal(second, String(1000 + 2 * 3600));
  const retry = { signature: sent[1]!.get("x-hookrelay-signature") ?? undefined, timestamp: second ?? undefined };
  assert.equal(verifySignature(Buffer.from('{"order":1}'), SECRET, retry, clock.time), "valid");
});
