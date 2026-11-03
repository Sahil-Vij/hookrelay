import express, { type NextFunction, type Request, type Response } from "express";
import type { Store } from "./db.ts";
import { verifySignature } from "./signature.ts";

export interface AppConfig {
  store: Store;
  secrets: Map<string, string>;
  /** Source name to forwarding URL. Sources without one are stored only. */
  targets?: Map<string, string>;
}

export function createApp({ store, secrets, targets = new Map() }: AppConfig) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Keep the exact bytes: signatures are over the raw body, and re-serialising JSON would break them.
  app.post("/hooks/:source", express.raw({ type: () => true, limit: "1mb" }), (req, res) => {
    const source = String(req.params.source);
    const secret = secrets.get(source);
    if (secret === undefined) {
      res.status(404).json({ error: "unknown_source" });
      return;
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifySignature(body, secret, req.get("x-hookrelay-signature"))) {
      res.status(401).json({ error: "invalid_signature" });
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
