import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { listEvents, UnauthorizedError, type DeliveryStatus, type EventFilters } from "./api.ts";
import { deliveryLabel, formatBytes, formatDateTime } from "./format.ts";

const PAGE_SIZE = 50;
const REFRESH_MS = 5000;

interface Props {
  apiKey: string;
  onSignOut: () => void;
  onUnauthorized: () => void;
}

export function EventsPage({ apiKey, onSignOut, onUnauthorized }: Props) {
  const [filters, setFilters] = useState<EventFilters>({});
  const [sourceDraft, setSourceDraft] = useState("");

  const query = useQuery({
    queryKey: ["events", filters],
    queryFn: ({ signal }) => listEvents(apiKey, { ...filters, limit: PAGE_SIZE }, signal),
    // New webhooks show up without a reload.
    refetchInterval: REFRESH_MS,
    // Keep the old rows on screen while a new filter loads, instead of flashing an empty table.
    placeholderData: keepPreviousData,
  });

  // The key can be rotated on the server while the dashboard is open.
  useEffect(() => {
    if (query.error instanceof UnauthorizedError) onUnauthorized();
  }, [query.error, onUnauthorized]);

  function applySource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilters((current) => ({ ...current, source: sourceDraft.trim() || undefined }));
  }

  function clearFilters() {
    setSourceDraft("");
    setFilters({});
  }

  const filtered = Boolean(filters.source || filters.status);
  const events = query.data?.events ?? [];

  return (
    <div className="page">
      <header className="top-bar">
        <h1>hookrelay</h1>
        <button type="button" className="secondary" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      <main>
        <h2>Events</h2>
        <form className="filters" role="search" onSubmit={applySource}>
          <div className="field">
            <label htmlFor="filter-source">Source</label>
            <input
              id="filter-source"
              name="source"
              type="search"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
              placeholder="Any source"
              value={sourceDraft}
              onChange={(e) => setSourceDraft(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="filter-status">Delivery</label>
            <select
              id="filter-status"
              name="status"
              autoComplete="off"
              value={filters.status ?? ""}
              onChange={(e) =>
                setFilters((current) => ({ ...current, status: (e.target.value || undefined) as DeliveryStatus | undefined }))
              }
            >
              <option value="">Any status</option>
              <option value="pending">Pending or retrying</option>
              <option value="delivered">Delivered</option>
              <option value="failed">Failed</option>
            </select>
          </div>
          <button type="submit">Filter</button>
          {filtered && (
            <button type="button" className="secondary" onClick={clearFilters}>
              Clear
            </button>
          )}
        </form>

        {query.isPending ? (
          <p className="state">Loading events…</p>
        ) : query.isError && !(query.error instanceof UnauthorizedError) && !query.data ? (
          <div className="state" role="alert">
            <p>Couldn't load events.</p>
            <button type="button" onClick={() => query.refetch()}>
              Try again
            </button>
          </div>
        ) : events.length === 0 ? (
          <p className="state">{filtered ? "No events match these filters." : "No events yet."}</p>
        ) : (
          <>
            <div className="table-scroll">
              <table aria-busy={query.isPlaceholderData}>
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Source</th>
                    <th scope="col">Received</th>
                    <th scope="col" className="number">
                      Size
                    </th>
                    <th scope="col">Delivery</th>
                    <th scope="col" className="number">
                      Attempts
                    </th>
                    <th scope="col">Last error</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => {
                    const status = deliveryLabel(event.delivery);
                    return (
                      <tr key={event.id}>
                        <td>#{event.id}</td>
                        <td>{event.source}</td>
                        <td>
                          <time dateTime={event.receivedAt}>{formatDateTime(event.receivedAt)}</time>
                        </td>
                        <td className="number">{formatBytes(event.byteLength)}</td>
                        <td>
                          <span className={`badge ${status.tone}`}>{status.label}</span>
                        </td>
                        <td className="number">{event.delivery?.attempts ?? "–"}</td>
                        <td className="error-text">{event.delivery?.lastError ?? "–"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {query.data?.nextCursor !== null && <p className="hint">Showing the newest {PAGE_SIZE} events.</p>}
            {query.isError && (
              <p className="error" role="alert">
                Refresh failed. Showing the last loaded results.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}
