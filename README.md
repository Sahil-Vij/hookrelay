# hookrelay

A self-hosted webhook inbox. Payment gateways, stores and shipping providers send webhooks once and move on, so a bad
deploy can silently lose events. hookrelay receives them safely, stores each one once, and keeps retrying delivery to your
app until it succeeds. Replay and a dashboard are coming next.

## Status

Early and under active development. See [issues](../../issues) for the roadmap.

| Feature | State |
| --- | --- |
| HMAC signature verification on raw bytes | Done |
| Idempotent storage, safe under concurrent retries | Done |
| Forwarding with retries and exponential backoff | Done |
| Authenticated events API | Done |
| React dashboard with search and replay | Planned |
| Postgres and Docker Compose | Planned |

## Try it

Requires Node 24+.

```sh
npm install
cp .env.example .env
npm run dev
```

```sh
BODY='{"event":"order.created"}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac change-me | awk '{print $NF}')"
curl -i localhost:4000/hooks/demo -H "x-hookrelay-signature: $SIG" -H "idempotency-key: evt-1" -d "$BODY"
```

| Response | Meaning |
| --- | --- |
| `202` | New event stored |
| `200` with `duplicate: true` | Already had it, nothing changed |
| `401` | Signature missing or wrong |
| `404` | Unknown source |
| `413` | Body over 1 MB |

## Forwarding

Set `HOOKRELAY_TARGETS` to forward a source's new events to your app. Each request carries the original bytes, a fresh
`x-hookrelay-signature`, and `x-hookrelay-event-id`, `x-hookrelay-source` and `x-hookrelay-attempt` headers.

A `2xx` response counts as delivered. Anything else, including a redirect, a timeout or a network error, is retried with
exponential backoff and jitter, up to 12 attempts over roughly 1 to 2.5 hours. After that the delivery is marked `failed`,
and the event stays stored.

**Delivery is at-least-once.** If the process dies after your app responds but before the result is saved, the event is
sent again, so use `x-hookrelay-event-id` to ignore repeats. Run a single worker for now, as multiple workers could send
the same event at once.

## Events API

Payloads can hold customer data, so every `/api` route needs the key from `HOOKRELAY_API_KEY`, and the server won't start
without one. Generate it with `openssl rand -hex 32`.

```sh
curl localhost:4000/api/events -H "authorization: Bearer $HOOKRELAY_API_KEY"
curl localhost:4000/api/events/1 -H "authorization: Bearer $HOOKRELAY_API_KEY"
```

`GET /api/events` returns events newest first, without bodies, and takes these optional query parameters:

| Parameter | Meaning |
| --- | --- |
| `source` | Only this source |
| `status` | Only deliveries that are `pending`, `delivered` or `failed` |
| `limit` | Page size from 1 to 100, default 50 |
| `before` | Pass the previous page's `nextCursor` to get the next page |

`GET /api/events/:id` adds the body. Text comes back with `bodyEncoding: "utf8"`, and anything that isn't valid UTF-8 comes
back with `bodyEncoding: "base64"`, so the original bytes are never altered.

`delivery` is `null` for a source with no forwarding target. A `null` `nextAttemptAt` on a pending delivery means it's due
now.

## Design notes

- **Raw bytes:** the signature is checked before any parsing, because re-serialising JSON changes the bytes.
- **Database-level dedupe:** a `UNIQUE` constraint decides, so concurrent retries can't both insert.
- **Constant-time comparison:** response timing can't reveal how close a forged signature was.
- **Same transaction:** an event and its delivery are saved together, so a stored event can't miss being forwarded.
- **Cursor paging:** paging by id stays stable while new events arrive, where an offset would repeat rows.
- **Retries survive restarts:** retry state lives in the database, not in memory.

## Development

```sh
npm test
npm run typecheck
```

## License

MIT
