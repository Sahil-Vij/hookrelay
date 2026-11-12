export type DeliveryStatus = "pending" | "delivered" | "failed";

export interface Delivery {
  status: DeliveryStatus;
  attempts: number;
  /** Null when nothing is scheduled, or when a pending delivery is due now. */
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
}

export interface EventSummary {
  id: number;
  source: string;
  idempotencyKey: string;
  contentType: string | null;
  receivedAt: string;
  byteLength: number;
  /** Null when the source has no forwarding target. */
  delivery: Delivery | null;
}

export interface EventDetail extends EventSummary {
  body: string;
  /** "base64" when the body wasn't valid UTF-8, so the bytes are never altered. */
  bodyEncoding: "utf8" | "base64";
}

export interface EventPage {
  events: EventSummary[];
  nextCursor: number | null;
}

export interface EventFilters {
  source?: string;
  status?: DeliveryStatus;
  limit?: number;
  /** The previous page's nextCursor. */
  before?: number;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("API key rejected");
    this.name = "UnauthorizedError";
  }
}

export class ApiError extends Error {
  readonly status: number;
  /** The server's `error` field, such as "already_pending", when the response had one. */
  readonly code: string | undefined;

  constructor(status: number, code?: string) {
    super(`Request failed with status ${status}${code ? ` (${code})` : ""}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function errorCode(res: Response) {
  try {
    const body: unknown = await res.json();
    const code = (body as { error?: unknown } | null)?.error;
    return typeof code === "string" ? code : undefined;
  } catch {
    // A proxy or crash page can answer with HTML, which has no code to read.
    return undefined;
  }
}

async function request<T>(
  path: string,
  apiKey: string,
  { method = "GET", signal }: { method?: "GET" | "POST"; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetch(path, { method, headers: { authorization: `Bearer ${apiKey}` }, signal });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new ApiError(res.status, await errorCode(res));
  return (await res.json()) as T;
}

export function listEvents(apiKey: string, filters: EventFilters = {}, signal?: AbortSignal) {
  const params = new URLSearchParams();
  if (filters.source) params.set("source", filters.source);
  if (filters.status) params.set("status", filters.status);
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.before) params.set("before", String(filters.before));
  const query = params.size > 0 ? `?${params}` : "";
  return request<EventPage>(`/api/events${query}`, apiKey, { signal });
}

export function getEvent(apiKey: string, id: number, signal?: AbortSignal) {
  return request<EventDetail>(`/api/events/${id}`, apiKey, { signal });
}

/** Queues the event for delivery again. Resolves with the event as it is now, without the body. */
export function replayEvent(apiKey: string, id: number) {
  return request<EventSummary>(`/api/events/${id}/replay`, apiKey, { method: "POST" });
}

export const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

/** Retrying won't fix a rejected key or a missing event, so only retry other failures. */
export const shouldRetry = (failureCount: number, error: unknown) =>
  !(error instanceof UnauthorizedError) && !isNotFound(error) && failureCount < 2;
