import { expect, test } from "vitest";
import { deliveryLabel, formatBytes } from "./format.ts";

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
