import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { EventDetail, EventSummary } from "./api.ts";
import { App } from "./App.tsx";

const KEY = "good-key";

const events: EventSummary[] = [
  {
    id: 3,
    source: "payments",
    idempotencyKey: "evt-3",
    contentType: "application/json",
    receivedAt: "2026-11-06T04:00:00.000Z",
    byteLength: 2048,
    delivery: { status: "failed", attempts: 12, nextAttemptAt: null, lastStatusCode: 500, lastError: "HTTP 500" },
  },
  {
    id: 2,
    source: "shop",
    idempotencyKey: "evt-2",
    contentType: "application/json",
    receivedAt: "2026-11-06T03:00:00.000Z",
    byteLength: 120,
    delivery: { status: "delivered", attempts: 1, nextAttemptAt: null, lastStatusCode: 200, lastError: null },
  },
  {
    id: 1,
    source: "shop",
    idempotencyKey: "evt-1",
    contentType: null,
    receivedAt: "2026-11-06T02:00:00.000Z",
    byteLength: 0,
    delivery: null,
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fake API that checks the key and records each request URL. */
function mockApi(respond: (url: URL) => Response | Promise<Response> = () => json({ events, nextCursor: null })) {
  const urls: URL[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    urls.push(url);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${KEY}`) return json({ error: "unauthorized" }, 401);
    return respond(url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { urls, fetchMock };
}

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

async function signIn(key = KEY) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("API key"), key);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  return user;
}

test("asks for an API key first and keeps it hidden", () => {
  mockApi();
  renderApp();
  const input = screen.getByLabelText("API key");
  expect(input.getAttribute("type")).toBe("password");
  expect(input.getAttribute("autocomplete")).toBe("current-password");
  expect(screen.queryByRole("table")).toBeNull();
});

test("a rejected key shows an error and isn't stored", async () => {
  mockApi();
  renderApp();
  await signIn("wrong-key");
  expect((await screen.findByRole("alert")).textContent).toBe("That key was rejected.");
  expect(sessionStorage.length).toBe(0);
});

test("explains when the server can't be reached", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
  renderApp();
  await signIn();
  expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't reach the server/);
});

test("signs in and lists events with their delivery status", async () => {
  mockApi();
  renderApp();
  await signIn();

  const table = await screen.findByRole("table");
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows.map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual(["#3", "#2", "#1"]);
  expect(within(rows[0]).getByText("Failed")).toBeTruthy();
  expect(within(rows[0]).getByText("HTTP 500")).toBeTruthy();
  expect(within(rows[0]).getByText("2.0 KB")).toBeTruthy();
  expect(within(rows[1]).getByText("Delivered")).toBeTruthy();
  expect(within(rows[2]).getByText("Stored only")).toBeTruthy();
  expect(sessionStorage.getItem("hookrelay.apiKey")).toBe(KEY);
});

test("trims whitespace pasted around the key", async () => {
  mockApi();
  renderApp();
  await signIn(`  ${KEY} `);
  expect(await screen.findByRole("table")).toBeTruthy();
});

test("filters by source and delivery status", async () => {
  const { urls } = mockApi((url) =>
    json({
      events: events.filter(
        (e) =>
          (!url.searchParams.has("source") || e.source === url.searchParams.get("source")) &&
          (!url.searchParams.has("status") || e.delivery?.status === url.searchParams.get("status")),
      ),
      nextCursor: null,
    }),
  );
  renderApp();
  const user = await signIn();
  await screen.findByRole("table");

  await user.type(screen.getByLabelText("Source"), "shop{Enter}");
  await vi.waitFor(() => expect(screen.queryByText("#3")).toBeNull(), { timeout: 5000 });
  expect(urls.at(-1)?.searchParams.get("source")).toBe("shop");

  await user.selectOptions(screen.getByLabelText("Delivery"), "delivered");
  await vi.waitFor(() => expect(screen.queryByText("#1")).toBeNull(), { timeout: 5000 });
  expect(urls.at(-1)?.searchParams.get("source")).toBe("shop");
  expect(urls.at(-1)?.searchParams.get("status")).toBe("delivered");
  expect(screen.getByText("#2")).toBeTruthy();

  await user.selectOptions(screen.getByLabelText("Delivery"), "failed");
  expect(await screen.findByText("No events match these filters.")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Clear" }));
  expect(await screen.findByText("#3")).toBeTruthy();
  expect(urls.at(-1)?.search).toBe("?limit=50");
  expect((screen.getByLabelText("Source") as HTMLInputElement).value).toBe("");
});

test("shows an empty state before any events arrive", async () => {
  mockApi(() => json({ events: [], nextCursor: null }));
  renderApp();
  await signIn();
  expect(await screen.findByText("No events yet.")).toBeTruthy();
});

test("offers a retry when loading fails", async () => {
  let fail = true;
  mockApi(() => (fail ? json({ error: "internal_error" }, 500) : json({ events, nextCursor: null })));
  sessionStorage.setItem("hookrelay.apiKey", KEY);
  renderApp();
  expect((await screen.findByRole("alert")).textContent).toMatch(/Couldn't load events/);

  fail = false;
  await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("table")).toBeTruthy();
});

test("goes back to sign in when the stored key stops working", async () => {
  sessionStorage.setItem("hookrelay.apiKey", "rotated-key");
  mockApi();
  renderApp();
  expect(await screen.findByText("Your API key was rejected. Sign in again.")).toBeTruthy();
  expect(screen.getByLabelText("API key")).toBeTruthy();
  expect(sessionStorage.length).toBe(0);
});

test("signing out forgets the key", async () => {
  mockApi();
  renderApp();
  const user = await signIn();
  await screen.findByRole("table");
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(screen.getByLabelText("API key")).toBeTruthy();
  expect(sessionStorage.length).toBe(0);
});

/** A fake API with N events, served newest first in pages that follow the cursor. */
function pagedApi(total: number) {
  const all = Array.from({ length: total }, (_, i) => ({ ...events[1], id: total - i, idempotencyKey: `evt-${total - i}` }));
  return mockApi((url) => {
    const before = Number(url.searchParams.get("before") ?? Infinity);
    const limit = Number(url.searchParams.get("limit"));
    const rest = all.filter((e) => e.id < before);
    const page = rest.slice(0, limit);
    return json({ events: page, nextCursor: rest.length > limit ? page[page.length - 1].id : null });
  });
}

test("loads older events page by page until there are none left", async () => {
  const { urls } = pagedApi(120);
  renderApp();
  const user = await signIn();
  expect(await screen.findByText("50 events shown")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Load older events" }));
  expect(await screen.findByText("100 events shown")).toBeTruthy();
  expect(urls.at(-1)?.searchParams.get("before")).toBe("71");

  await user.click(screen.getByRole("button", { name: "Load older events" }));
  expect(await screen.findByText("120 events shown")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load older events" })).toBeNull();

  const ids = within(screen.getByRole("table"))
    .getAllByRole("link")
    .map((link) => Number(link.textContent?.slice(1)));
  expect(ids).toEqual(Array.from({ length: 120 }, (_, i) => 120 - i));
});

test("hides the load button when everything fits on one page", async () => {
  mockApi();
  renderApp();
  await signIn();
  expect(await screen.findByText("3 events shown")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load older events" })).toBeNull();
});

const detail = (overrides: Partial<EventDetail> = {}): EventDetail => ({
  ...events[0],
  body: '{"type":"payment.captured","amount":4999}',
  bodyEncoding: "utf8",
  ...overrides,
});

/** Serves the list, and the given event details by id. */
function detailApi(details: Record<number, EventDetail>) {
  return mockApi((url) => {
    const match = /^\/api\/events\/(\d+)$/.exec(url.pathname);
    if (!match) return json({ events, nextCursor: null });
    const found = details[Number(match[1])];
    return found ? json(found) : json({ error: "not_found" }, 404);
  });
}

function openAt(hash: string) {
  window.location.hash = hash;
  sessionStorage.setItem("hookrelay.apiKey", KEY);
}

test("opens an event from the list and goes back with filters kept", async () => {
  detailApi({ 3: detail() });
  renderApp();
  const user = await signIn();
  await screen.findByRole("table");
  await user.type(screen.getByLabelText("Source"), "payments");

  await user.click(screen.getByRole("link", { name: "#3" }));
  const heading = await screen.findByRole("heading", { name: "Event #3" });
  expect(document.activeElement).toBe(heading);
  expect(window.location.hash).toBe("#/events/3");
  const view = within(heading.closest("main") as HTMLElement);
  expect((await view.findByText(/"amount": 4999/)).tagName).toBe("PRE");
  expect(view.getByText("HTTP 500")).toBeTruthy();
  expect(view.getByText("evt-3")).toBeTruthy();

  await user.click(screen.getByRole("link", { name: "← All events" }));
  expect(await screen.findByRole("heading", { name: "Events" })).toBeTruthy();
  expect((screen.getByLabelText("Source") as HTMLInputElement).value).toBe("payments");
});

test("opens straight to an event from a link", async () => {
  openAt("#/events/3");
  detailApi({ 3: detail() });
  renderApp();
  expect(await screen.findByRole("heading", { name: "Event #3" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Events" })).toBeNull();
  expect(await screen.findByText(/"type": "payment.captured"/)).toBeTruthy();
});

test("shows the exact body by default when formatting would change it", async () => {
  const raw = '{"id":12345678901234567890}';
  openAt("#/events/3");
  detailApi({ 3: detail({ body: raw }) });
  renderApp();
  expect(await screen.findByText(raw)).toBeTruthy();

  await userEvent.setup().click(screen.getByRole("button", { name: "Formatted" }));
  expect(screen.getByText(/Formatting changes this body/)).toBeTruthy();
  expect(screen.queryByText(raw)).toBeNull();
});

test("shows a body that isn't valid UTF-8 as base64", async () => {
  openAt("#/events/3");
  detailApi({ 3: detail({ body: "//79AH8=", bodyEncoding: "base64" }) });
  renderApp();
  expect(await screen.findByText("//79AH8=")).toBeTruthy();
  expect(screen.getByText(/shown as base64/)).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Body view" })).toBeNull();
});

test("shows when a delivery will be retried next", async () => {
  openAt("#/events/3");
  detailApi({
    3: detail({
      delivery: {
        status: "pending",
        attempts: 2,
        nextAttemptAt: "2026-11-10T05:00:00.000Z",
        lastStatusCode: 503,
        lastError: "HTTP 503",
      },
    }),
  });
  renderApp();
  expect(await screen.findByText("Retrying")).toBeTruthy();
  expect(screen.getByText("Next attempt")).toBeTruthy();
  expect(screen.getByText("503")).toBeTruthy();
});

test("says when an event doesn't exist", async () => {
  openAt("#/events/999");
  detailApi({});
  renderApp();
  expect(await screen.findByText("This event doesn't exist.")).toBeTruthy();
});
