import type { AttemptResult, DueDelivery, Store } from "./db.ts";
import { sign } from "./signature.ts";

export interface WorkerConfig {
  store: Store;
  secrets: Map<string, string>;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  batchSize?: number;
  pollIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  random?: () => number;
}

/**
 * Doubles the wait after each failed attempt, up to a cap. The wait is then randomised between 50% and
 * 100%, so events that failed together during an outage don't all retry at the same moment.
 */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, random: () => number): number {
  const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(delay * (0.5 + random() * 0.5));
}

export function createDeliveryWorker(config: WorkerConfig) {
  const {
    store,
    secrets,
    maxAttempts = 12,
    baseDelayMs = 5_000,
    maxDelayMs = 3_600_000,
    timeoutMs = 10_000,
    batchSize = 50,
    pollIntervalMs = 1_000,
    fetch: doFetch = globalThis.fetch,
    now = Date.now,
    random = Math.random,
  } = config;

  let running: Promise<number> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = true;

  async function attempt(delivery: DueDelivery): Promise<Omit<AttemptResult, "attempts">> {
    const secret = secrets.get(delivery.source);
    if (secret === undefined) return { statusCode: null, error: `no secret for source ${delivery.source}` };

    // A fresh timestamp on every attempt, so a retry hours later still passes the receiver's freshness check.
    const timestamp = Math.floor(now() / 1000);
    const headers: Record<string, string> = {
      "x-hookrelay-signature": sign(delivery.body, secret, timestamp),
      "x-hookrelay-timestamp": String(timestamp),
      "x-hookrelay-event-id": String(delivery.eventId),
      "x-hookrelay-source": delivery.source,
      "x-hookrelay-attempt": String(delivery.attempts + 1),
    };
    if (delivery.contentType) headers["content-type"] = delivery.contentType;

    try {
      const response = await doFetch(delivery.targetUrl, {
        method: "POST",
        headers,
        body: new Uint8Array(delivery.body),
        // A redirect isn't an acknowledgement, and following one could send the payload somewhere unexpected.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Only the status matters. Cancelling the body frees the connection without reading it.
      await response.body?.cancel();
      return { statusCode: response.status, error: response.ok ? null : `HTTP ${response.status}` };
    } catch (error) {
      return { statusCode: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function processBatch(): Promise<number> {
    const due = store.dueDeliveries(now(), batchSize);
    for (const delivery of due) {
      const outcome = await attempt(delivery);
      const result: AttemptResult = { ...outcome, attempts: delivery.attempts + 1 };
      if (outcome.error === null) {
        store.markDelivered(delivery.id, result);
      } else if (result.attempts >= maxAttempts) {
        store.markFailed(delivery.id, result);
      } else {
        store.markRetry(delivery.id, result, now() + backoffDelay(result.attempts, baseDelayMs, maxDelayMs, random));
      }
    }
    return due.length;
  }

  /** Processes everything due right now. Overlapping calls share one run, so nothing is sent twice. */
  function runOnce(): Promise<number> {
    running ??= processBatch().finally(() => {
      running = null;
    });
    return running;
  }

  function schedule() {
    timer = setTimeout(async () => {
      try {
        await runOnce();
      } catch (error) {
        console.error("delivery worker error", error);
      }
      if (!stopped) schedule();
    }, pollIntervalMs);
  }

  return {
    runOnce,
    start() {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    /** Stops polling and waits for any delivery in progress. */
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running?.catch(() => {});
    },
  };
}
