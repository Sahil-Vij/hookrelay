import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { ApiError, getEvent, isNotFound, replayEvent, UnauthorizedError, type EventDetail } from "./api.ts";
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
        <>
          {/* Keyed so a message about one event never shows on another. */}
          <ReplayControl key={id} apiKey={apiKey} event={query.data} onUnauthorized={onUnauthorized} />
          <EventDetails event={query.data} />
        </>
      )}
    </main>
  );
}

function replayErrorMessage(error: unknown, source: string) {
  if (error instanceof ApiError) {
    if (error.code === "already_pending") return "This event is already being delivered. Replay it once that finishes.";
    if (error.code === "no_target")
      return `The "${source}" source has no target URL, so there's nowhere to send it. Add one to HOOKRELAY_TARGETS and try again.`;
    if (error.status === 404) return "This event doesn't exist any more.";
  }
  return "Couldn't replay this event. Try again.";
}

interface ReplayProps {
  apiKey: string;
  event: EventDetail;
  onUnauthorized: () => void;
}

function ReplayControl({ apiKey, event, onUnauthorized }: ReplayProps) {
  const queryClient = useQueryClient();
  const hintId = useId();
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const replay = useMutation({
    mutationFn: () => replayEvent(apiKey, event.id),
    onMutate: () => setMessage(null),
    onSuccess: (queued) => {
      // Show the new pending state now; the page keeps polling while it's pending.
      queryClient.setQueryData<EventDetail>(["event", event.id], (old) => old && { ...old, ...queued });
      setMessage({ tone: "success", text: "Replay queued. It goes to the source's current target." });
    },
    onError: (error) => {
      if (error instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setMessage({ tone: "error", text: replayErrorMessage(error, event.source) });
      // Another tab may have replayed it, so show where it is now.
      if (error instanceof ApiError && error.code === "already_pending") {
        void queryClient.invalidateQueries({ queryKey: ["event", event.id] });
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["events"] }),
  });

  const inProgress = event.delivery?.status === "pending";
  const unavailable = inProgress || replay.isPending;

  return (
    <div className="replay">
      <div className="replay-actions">
        {/*
          aria-disabled rather than disabled: a disabled button drops focus to the page
          the moment it's clicked, and can't be reached to learn why it's unavailable.
        */}
        <button
          type="button"
          aria-disabled={unavailable}
          aria-describedby={inProgress ? hintId : undefined}
          onClick={() => {
            if (!unavailable) replay.mutate();
          }}
        >
          {replay.isPending ? "Replaying…" : "Replay"}
        </button>
        {inProgress && (
          <span id={hintId} className="hint">
            Available once the current delivery finishes.
          </span>
        )}
      </div>
      {/* Always rendered, so screen readers are already watching it when the message arrives. */}
      <p role="status" className={message ? message.tone : undefined}>
        {message?.text}
      </p>
    </div>
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
