import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { getEvent, isNotFound, UnauthorizedError, type EventDetail } from "./api.ts";
import { deliveryLabel, formatBytes, formatDateTime, formatJson } from "./format.ts";
import { listHref } from "./route.ts";

const REFRESH_MS = 5000;

interface Props {
  apiKey: string;
  id: number;
  onUnauthorized: () => void;
}

export function EventDetailPage({ apiKey, id, onUnauthorized }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  const query = useQuery({
    queryKey: ["event", id],
    queryFn: ({ signal }) => getEvent(apiKey, id, signal),
    // Only a pending delivery can still change.
    refetchInterval: (q) => (q.state.data?.delivery?.status === "pending" ? REFRESH_MS : false),
  });

  useEffect(() => {
    if (query.error instanceof UnauthorizedError) onUnauthorized();
  }, [query.error, onUnauthorized]);

  // Move focus to the new view, so keyboard and screen reader users aren't left on a link that's gone.
  useEffect(() => {
    heading.current?.focus();
  }, [id]);

  return (
    <main>
      <a href={listHref} className="back-link">
        ← All events
      </a>
      <h2 ref={heading} tabIndex={-1}>
        Event #{id}
      </h2>
      {query.isPending ? (
        <p className="state">Loading event…</p>
      ) : query.isError && !query.data ? (
        isNotFound(query.error) ? (
          <p className="state">This event doesn't exist.</p>
        ) : (
          <div className="state" role="alert">
            <p>Couldn't load this event.</p>
            <button type="button" onClick={() => query.refetch()}>
              Try again
            </button>
          </div>
        )
      ) : (
        <EventDetails event={query.data} />
      )}
    </main>
  );
}

function EventDetails({ event }: { event: EventDetail }) {
  const status = deliveryLabel(event.delivery);
  const delivery = event.delivery;
  return (
    <>
      <section className="card detail-grid" aria-label="Event">
        <dl>
          <dt>Source</dt>
          <dd>{event.source}</dd>
          <dt>Received</dt>
          <dd>
            <time dateTime={event.receivedAt}>{formatDateTime(event.receivedAt)}</time>
          </dd>
          <dt>Idempotency key</dt>
          <dd>
            <code>{event.idempotencyKey}</code>
          </dd>
          <dt>Content type</dt>
          <dd>{event.contentType ?? "–"}</dd>
          <dt>Size</dt>
          <dd>{formatBytes(event.byteLength)}</dd>
        </dl>
        <dl>
          <dt>Delivery</dt>
          <dd>
            <span className={`badge ${status.tone}`}>{status.label}</span>
          </dd>
          {delivery && (
            <>
              <dt>Attempts</dt>
              <dd>{delivery.attempts}</dd>
              {delivery.status === "pending" && (
                <>
                  <dt>Next attempt</dt>
                  <dd>
                    {delivery.nextAttemptAt ? (
                      <time dateTime={delivery.nextAttemptAt}>{formatDateTime(delivery.nextAttemptAt)}</time>
                    ) : (
                      "Due now"
                    )}
                  </dd>
                </>
              )}
              <dt>Last response</dt>
              <dd>{delivery.lastStatusCode ?? "–"}</dd>
              <dt>Last error</dt>
              <dd className="error-text-wrap">{delivery.lastError ?? "–"}</dd>
            </>
          )}
        </dl>
      </section>
      <EventBody event={event} />
    </>
  );
}

function EventBody({ event }: { event: EventDetail }) {
  const json = event.bodyEncoding === "utf8" ? formatJson(event.body) : null;
  // Formatted by default only when it means exactly what was received.
  const [view, setView] = useState<"formatted" | "raw">(json?.lossless ? "formatted" : "raw");
  const showFormatted = json !== null && view === "formatted";

  return (
    <section className="body-section" aria-labelledby="body-heading">
      <div className="body-header">
        <h3 id="body-heading">Body</h3>
        {json && (
          <div className="segmented" role="group" aria-label="Body view">
            <button type="button" aria-pressed={showFormatted} onClick={() => setView("formatted")}>
              Formatted
            </button>
            <button type="button" aria-pressed={!showFormatted} onClick={() => setView("raw")}>
              Raw
            </button>
          </div>
        )}
      </div>
      {event.bodyEncoding === "base64" && <p className="hint">Not valid UTF-8, so it's shown as base64.</p>}
      {showFormatted && !json.lossless && (
        <p className="notice">
          Formatting changes this body, for example by rounding very large numbers or merging duplicate keys. Raw shows
          exactly what was received.
        </p>
      )}
      {event.body === "" ? (
        <p className="hint">Empty body.</p>
      ) : (
        <pre className="body" tabIndex={0}>
          {showFormatted ? json.formatted : event.body}
        </pre>
      )}
    </section>
  );
}
