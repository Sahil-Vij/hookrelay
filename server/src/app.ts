import express, { type NextFunction, type Request, type Response } from "express";
import { createApiRouter } from "./api.ts";
import type { Store } from "./db.ts";
import { DEFAULT_TOLERANCE_SECONDS, verifySignature } from "./signature.ts";

export interface AppConfig {
  store: Store;
  secrets: Map<string, string>;
  /** Source name to forwarding URL. Sources without one are stored only. */
  targets?: Map<string, string>;
  /** Bearer token for the events API. */
  apiKey: string;
  /** How old, or how far in the future, a signed timestamp may be. */
  toleranceSeconds?: number;
  now?: () => number;
}

export function createApp({
  store,
  secrets,
  targets = new Map(),
  apiKey,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  now = Date.now,
}: AppConfig) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api", createApiRouter({ store, apiKey, targets }));

  // Keep the exact bytes: signatures are over the raw body, and re-serialising JSON would break them.
  app.post("/hooks/:source", express.raw({ type: () => true, limit: "1mb" }), (req, res) => {
    const source = String(req.params.source);
    const secret = secrets.get(source);
    if (secret === undefined) {
      res.status(404).json({ error: "unknown_source" });
      return;
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const check = verifySignature(
      body,
      secret,
      { signature: req.get("x-hookrelay-signature"), timestamp: req.get("x-hookrelay-timestamp") },
      now(),
      toleranceSeconds,
    );
    if (check !== "valid") {
      // "expired" is only reported for a correctly signed request, so it tells a forger nothing.
      res.status(401).json({ error: check === "expired" ? "expired_timestamp" : "invalid_signature" });
      return;
    }
    const { id, duplicate } = store.saveEvent({
      source,
      idempotencyKey: req.get("idempotency-key"),
      contentType: req.get("content-type"),
      body,
      targetUrl: targets.get(source),
    });
    res.status(duplicate ? 200 : 202).json({ id, duplicate });
  });

  app.use((err: { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.status === 413) {
      res.status(413).json({ error: "payload_too_large" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
