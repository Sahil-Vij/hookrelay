import { createHmac, timingSafeEqual } from "node:crypto";

export function sign(body: Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Constant-time check, so response timing can't reveal how much of a signature was right. */
export function verifySignature(body: Buffer, secret: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(sign(body, secret));
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
