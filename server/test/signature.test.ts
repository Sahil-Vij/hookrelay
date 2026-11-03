import assert from "node:assert/strict";
import { test } from "node:test";
import { sign, verifySignature } from "../src/signature.ts";

const body = Buffer.from('{"event":"order.created"}');

test("accepts a signature made with the same secret", () => {
  assert.equal(verifySignature(body, "secret", sign(body, "secret")), true);
});

test("rejects a signature made with another secret", () => {
  assert.equal(verifySignature(body, "secret", sign(body, "other")), false);
});

test("rejects a changed body", () => {
  assert.equal(verifySignature(Buffer.from("{}"), "secret", sign(body, "secret")), false);
});

test("rejects missing and wrong-length signatures without throwing", () => {
  assert.equal(verifySignature(body, "secret", undefined), false);
  assert.equal(verifySignature(body, "secret", "sha256=abc"), false);
});
