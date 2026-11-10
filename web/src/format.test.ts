import { expect, test } from "vitest";
import { deliveryLabel, formatBytes, formatJson } from "./format.ts";

test("labels each delivery state", () => {
  const base = { nextAttemptAt: null, lastStatusCode: null, lastError: null };
  expect(deliveryLabel(null).label).toBe("Stored only");
  expect(deliveryLabel({ ...base, status: "pending", attempts: 0 }).label).toBe("Pending");
  expect(deliveryLabel({ ...base, status: "pending", attempts: 3 }).label).toBe("Retrying");
  expect(deliveryLabel({ ...base, status: "delivered", attempts: 1 }).tone).toBe("success");
  expect(deliveryLabel({ ...base, status: "failed", attempts: 12 }).tone).toBe("danger");
});

test("formats sizes", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1023)).toBe("1023 B");
  expect(formatBytes(1024)).toBe("1.0 KB");
  expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
});

test("formats JSON and says when that would change the body", () => {
  expect(formatJson('{"a": 1, "b": [true, null]}')).toEqual({
    formatted: '{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}',
    lossless: true,
  });
  expect(formatJson('{"s": "keeps  spaces"}')?.lossless).toBe(true);
  expect(formatJson('{"s": "quote \\" inside"}')?.lossless).toBe(true);
  expect(formatJson('{"n": 12345678901234567890}')?.lossless).toBe(false);
  expect(formatJson('{"a": 1, "a": 2}')?.lossless).toBe(false);
  expect(formatJson('{"e": "\\u00e9"}')?.lossless).toBe(false);
  expect(formatJson('{"f": 1.0}')?.lossless).toBe(false);
  expect(formatJson("not json")).toBeNull();
  expect(formatJson("")).toBeNull();
});
