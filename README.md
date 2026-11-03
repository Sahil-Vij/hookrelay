# hookrelay

A self-hosted webhook inbox. Payment gateways, stores and shipping providers send webhooks once and move on, so a bad
deploy can silently lose events. hookrelay receives them safely and stores each one once. Forwarding, retries, replay and
a dashboard are coming next.

## Status

Early and under active development. See [issues](../../issues) for the roadmap.

| Feature | State |
| --- | --- |
| HMAC signature verification on raw bytes | Done |
| Idempotent storage, safe under concurrent retries | Done |
| Forwarding with retries and exponential backoff | Planned |
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

## Design notes

- **Raw bytes:** the signature is checked before any parsing, because re-serialising JSON changes the bytes.
- **Database-level dedupe:** a `UNIQUE` constraint decides, so concurrent retries can't both insert.
- **Constant-time comparison:** response timing can't reveal how close a forged signature was.

## Development

```sh
npm test
npm run typecheck
```

## License

MIT
