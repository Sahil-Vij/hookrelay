import { createHmac, timingSafeEqual } from "node:crypto";

/** How far a signed timestamp may be from the receiver's clock, either way, by default. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Signs `<timestamp>.<body>`. Covering the timestamp means it can't be changed without breaking the
 * signature, so a captured request can only be replayed while its timestamp is still fresh.
 */
export function sign(body: Buffer, secret: string, timestamp: number): string {
  const hmac = createHmac("sha256", secret).update(`${timestamp}.`).update(body);
  return `sha256=${hmac.digest("hex")}`;
}

export type SignatureCheck = "valid" | "invalid" | "expired";

export interface SignatureInput {
  signature: string | undefined;
  timestamp: string | undefined;
}

/**
 * Checks the signature first and the timestamp second, so "expired" is only ever reported for a request
 * that really was signed with the secret. Comparison is constant-time, so response timing can't reveal
 * how much of a signature was right.
 */
export function verifySignature(
  body: Buffer,
  secret: string,
  { signature, timestamp }: SignatureInput,
  nowMs: number,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
): SignatureCheck {
  if (!signature || !timestamp || !/^\d{1,12}$/.test(timestamp)) return "invalid";
  const seconds = Number(timestamp);
  const expected = Buffer.from(sign(body, secret, seconds));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return "invalid";
  return Math.abs(nowMs / 1000 - seconds) > toleranceSeconds ? "expired" : "valid";
}
