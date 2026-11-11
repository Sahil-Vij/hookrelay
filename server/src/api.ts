import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import type { DeliveryState, DeliveryStatus, EventDetail, EventSummary, Store } from "./db.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const STATUSES: readonly string[] = ["pending", "delivered", "failed"] satisfies DeliveryStatus[];

const sha256 = (value: string) => createHash("sha256").update(value).digest();

function requireApiKey(apiKey: string) {
  // Hashing gives both sides the same length, which timingSafeEqual requires.
  const expected = sha256(apiKey);
  return (req: Request, res: Response, next: NextFunction) => {
    const token = /^Bearer (\S+)$/i.exec(req.get("authorization") ?? "")?.[1];
    if (token === undefined || !timingSafeEqual(sha256(token), expected)) {
      res.set("WWW-Authenticate", "Bearer").status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

/** Returns undefined for anything but a plain positive integer, including repeated query parameters. */
function parseId(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function encodeBody(body: Buffer) {
  try {
    return { body: decoder.decode(body), bodyEncoding: "utf8" };
  } catch {
    return { body: body.toString("base64"), bodyEncoding: "base64" };
  }
}

const serializeDelivery = (delivery: DeliveryState | null) =>
  delivery && {
    ...delivery,
    // Stored as epoch milliseconds, with 0 meaning nothing is scheduled.
    nextAttemptAt: delivery.nextAttemptAt > 0 ? new Date(delivery.nextAttemptAt).toISOString() : null,
  };

const serializeEvent = <T extends EventSummary>(event: T) => ({
  ...event,
  delivery: serializeDelivery(event.delivery),
});

interface ApiConfig {
  store: Store;
  apiKey: string;
  /** Source name to forwarding URL, used when replaying. */
  targets?: Map<string, string>;
}

export function createApiRouter({ store, apiKey, targets = new Map() }: ApiConfig) {
  // An empty key would match an empty token, so refuse to run with an open API.
  if (!apiKey) throw new Error("apiKey must not be empty");

  const router = Router();

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.use(requireApiKey(apiKey));

  router.get("/events", (req, res) => {
    const { source, status, limit: rawLimit, before: rawBefore } = req.query;
    const limit = rawLimit === undefined ? DEFAULT_LIMIT : parseId(rawLimit);
    const before = rawBefore === undefined ? undefined : parseId(rawBefore);

    const invalid =
      (source !== undefined && typeof source !== "string") ||
      (status !== undefined && (typeof status !== "string" || !STATUSES.includes(status))) ||
      limit === undefined ||
      limit > MAX_LIMIT ||
      (rawBefore !== undefined && before === undefined);
    if (invalid) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }

    // One extra row shows whether another page exists, without a separate count query.
    const rows = store.listEvents({
      source: source as string | undefined,
      status: status as DeliveryStatus | undefined,
      beforeId: before,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    res.json({
      events: page.map(serializeEvent),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    });
  });

  router.get("/events/:id", (req, res) => {
    const id = parseId(req.params.id);
    const event = id === undefined ? undefined : store.getEvent(id);
    if (!event) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { body, ...rest } = event;
    res.json({ ...serializeEvent(rest), ...encodeBody(body) });
  });

  // Auth is a bearer header rather than a cookie, so another site can't trigger this from a user's browser.
  router.post("/events/:id/replay", (req, res) => {
    const id = parseId(req.params.id);
    const event = id === undefined ? undefined : store.getEvent(id);
    if (!event) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // The current target, so a replay reaches the app where it runs now, not where it ran when the event arrived.
    const target = targets.get(event.source);
    if (target === undefined) {
      res.status(409).json({ error: "no_target" });
      return;
    }
    const result = store.replay(event.id, target);
    if (result !== "queued") {
      res.status(result === "not_found" ? 404 : 409).json({ error: result });
      return;
    }
    const { body: _body, ...queued } = store.getEvent(event.id) as EventDetail;
    res.status(202).json(serializeEvent(queued));
  });

  router.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return router;
}
