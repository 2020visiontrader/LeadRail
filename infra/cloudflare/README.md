# Cloudflare inbound email — leadrail-inbound-mail

## Purpose

Routes inbound email on the `leadrail.xyz` zone into the LeadRail inbox. Cloudflare
Email Routing invokes a Cloudflare Email Worker for each matched address; the worker
parses the message, POSTs it to the LeadRail webhook, and forwards a copy to the
correct venture Gmail so nothing is lost even if the webhook is down.

- **Worker script name:** `leadrail-inbound-mail`
- **Zone:** `leadrail.xyz`
- **Source:** [`leadrail-inbound-mail.mjs`](./leadrail-inbound-mail.mjs) (this directory)

## Email Routing rules

All 5 addresses on `leadrail.xyz` use Cloudflare Email Routing rules with action type
`worker` → `leadrail-inbound-mail`:

- `franck@leadrail.xyz`
- `hello@leadrail.xyz`
- `francksayshello@leadrail.xyz`
- `rentahub@leadrail.xyz`
- `retentionrail@leadrail.xyz`

The per-address Gmail forward map lives inside the worker (`FORWARD_MAP`):

| Address | Forwards to |
|---|---|
| franck@, hello@, francksayshello@ | leadrailos@gmail.com |
| rentahub@ | therentahub@gmail.com |
| retentionrail@ | francklrail@gmail.com |

## Critical dependency: `email_accounts` mapping

Every inbound address also needs a matching row in the app's `email_accounts` table
(columns: `account_id`, `provider`, `address`, `status`). If an address has no row,
`ingestInboundEmail` (`lib/inbox/ingest.ts`) drops the mail as `no_mapping` — the
worker will still forward it to Gmail, but it won't land in the LeadRail inbox.

All 5 addresses above are currently mapped to account
`00000000-0000-0000-0000-0000000000b1` (BDB Productions).

## Webhook

- Route: `app/api/webhooks/inbound-email/route.ts`
- Auth: shared secret, header `x-inbound-secret`
- Secret env var: `INBOUND_EMAIL_SECRET` (set in `.env.local` / `.env.production.local`
  / `.env.production`, all gitignored — never committed)
- The worker sends the secret as the `x-inbound-secret` header on every POST to
  `https://app.leadrail.xyz/api/webhooks/inbound-email`.

The committed worker source has the `SECRET` constant redacted to a placeholder. The
real value is set inline directly in the deployed Cloudflare worker, matching
`INBOUND_EMAIL_SECRET`.

## Deploy (redacted)

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<ACCT>/workers/scripts/leadrail-inbound-mail" \
  -H "X-Auth-Email: <email>" \
  -H "X-Auth-Key: <global-key>" \
  -F 'metadata={"main_module":"leadrail-inbound-mail.mjs","compatibility_date":"2024-11-01"};type=application/json' \
  -F "leadrail-inbound-mail.mjs=@leadrail-inbound-mail.mjs;type=application/javascript+module"
```

Before deploying, set the real `SECRET` value inline in the worker file used for that
deploy (do not commit it).

## Notes

- After rebinding a routing rule to the worker, allow ~1-2 minutes of propagation
  before mail actually flows.
- **FilmOps (`filmopsai.com`) is a separate Cloudflare zone.** Never modify it while
  working on this worker.
