import assert from "node:assert/strict";
import { test } from "node:test";
import { sign, verifySignature } from "../src/signature.ts";

const body = Buffer.from('{"event":"order.created"}');
const T = 1_700_000_000;
const NOW = T * 1000;
const signed = (b = body, secret = "secret", timestamp = T) => ({
  signature: sign(b, secret, timestamp),
  timestamp: String(timestamp),
});

test("accepts a fresh signature made with the same secret", () => {
  assert.equal(verifySignature(body, "secret", signed(), NOW), "valid");
});

test("rejects a signature made with another secret", () => {
  assert.equal(verifySignature(body, "secret", signed(body, "other"), NOW), "invalid");
});

test("rejects a changed body", () => {
  assert.equal(verifySignature(Buffer.from("{}"), "secret", signed(), NOW), "invalid");
});

test("rejects a changed timestamp", () => {
  const input = { ...signed(), timestamp: String(T + 1) };
  assert.equal(verifySignature(body, "secret", input, NOW), "invalid");
});

test("signs the timestamp and body together, not either alone", () => {
  assert.notEqual(sign(body, "secret", T), sign(body, "secret", T + 1));
  assert.notEqual(sign(body, "secret", T), sign(Buffer.from("{}"), "secret", T));
});

test("expires outside the tolerance in either direction, at exactly the boundary", () => {
  assert.equal(verifySignature(body, "secret", signed(), NOW + 300_000), "valid");
  assert.equal(verifySignature(body, "secret", signed(), NOW + 301_000), "expired");
  assert.equal(verifySignature(body, "secret", signed(), NOW - 300_000), "valid");
  assert.equal(verifySignature(body, "secret", signed(), NOW - 301_000), "expired");
  assert.equal(verifySignature(body, "secret", signed(), NOW + 61_000, 60), "expired");
});

test("rejects missing, malformed and wrong-length values without throwing", () => {
  const good = signed().signature;
  assert.equal(verifySignature(body, "secret", { signature: undefined, timestamp: String(T) }, NOW), "invalid");
  assert.equal(verifySignature(body, "secret", { signature: good, timestamp: undefined }, NOW), "invalid");
  assert.equal(verifySignature(body, "secret", { signature: "sha256=abc", timestamp: String(T) }, NOW), "invalid");
  for (const timestamp of ["", "abc", "1e9", " 1700000000", "-1"]) {
    assert.equal(verifySignature(body, "secret", { signature: good, timestamp }, NOW), "invalid", timestamp);
  }
});
