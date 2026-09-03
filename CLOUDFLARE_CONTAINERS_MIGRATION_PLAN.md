# LeadRail: Zo Service → Cloudflare Containers — Migration Scope

Status: scoped, not started. Date: 2026-09-03.

## Why

The Zo-hosted `leadrail-crm` service has a real process-lifecycle bug: a routine
restart can leave the old `next start` process holding port 3200 while the new
one dies on `EADDRINUSE`, so the service silently keeps serving the previous
build. `curl`/`ps` reads healthy either way — the only way to catch it is
grepping the compiled bundle for new code, which happened twice this week.
Separately, `update_user_service` has no partial-update mode: every config
change or restart dumps the full plaintext secret block into the session
(Supabase service-role key, session secret, all provider keys).

Cloudflare Containers replaces process management with image replacement —
Cloudflare deploys a new container instance and atomically swaps it in, so
there's no "old process squatting the port" failure mode. Secrets move to
`wrangler secret put`, which sets one named value at a time and never prints
the full env block back.

## Why Containers, not Workers + OpenNext

LeadRail is a real Node.js `next start` server (confirmed, not standalone
output — `next.config.js` has no `output: 'standalone'`), and it depends on:

- `pdfkit`, `docx`, `xlsx`, `mammoth`, `jszip`, `pdf-parse` — all explicitly
  marked `serverComponentsExternalPackages` in `next.config.js` today because
  they're "heavy Node-only libs" the webpack config keeps out of edge bundles.
- `/api/agent/stream` — SSE route with `maxDuration = 300` (5 min).

The OpenNext Cloudflare adapter targets the Workers runtime (`workerd`), which
has known compatibility gaps for exactly this kind of Node-native dependency
and imposes Workers' execution model on long-lived streams. Containers run the
existing Node.js server unchanged inside a real Docker image — same runtime,
same libraries, no adapter, no compatibility matrix to check. Confirmed via
Cloudflare's own docs: Containers have full disk access and no ~30s runtime
cap (unlike Workers), which removes the SSE-duration question entirely.

## Target architecture

```
Request → Cloudflare edge → thin Worker (routes to container) → Durable Object
          (tracks container instance) → Container (existing Next.js server)
```

Cloudflare's model: a Worker sits in front of every Container and proxies to
it; each container gets its own Durable Object for lifecycle/instance
tracking. This Worker is boilerplate (a few lines), not new application logic.

Supabase `pg_cron` hitting `/api/hermes/tick` every 5 minutes is unaffected —
it's an external HTTP call regardless of what's behind the URL.

## Concrete changes required

**1. `next.config.js`** — add `output: 'standalone'`. Without it, the image
would have to ship the full 645 MB `node_modules`; standalone output traces
only the deps actually used and produces a minimal `.next/standalone` server.

**2. New `Dockerfile`** (none exists today):
```dockerfile
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3200
CMD ["node", "server.js"]
```
(Skeleton — needs a real build/test pass; multi-stage keeps the final image
Docker-slim instead of carrying `node_modules` + devDependencies.)

**3. `wrangler.jsonc`** — new file, container binding + instance size:
```jsonc
{
  "name": "leadrail-crm",
  "containers": [
    { "name": "leadrail-crm", "image": "./Dockerfile", "instance_type": "standard" }
  ]
}
```
Cloudflare's fixed instance tiers: `dev` (256 MB / 1/16 vCPU), `basic` (1 GB /
1/4 vCPU), `standard` (4 GB / 1/2 vCPU). `standard` is the only one that's a
plausible fit — needs a real memory profile under load (xlsx/docx generation
and mammoth parsing are the likely spikes) before trusting it, not assumed.

**4. Secrets migration** — move these from the Zo service env to
`wrangler secret put <NAME>` (names only, listed for planning; no values
here or anywhere in chat per the standing rule on secret handling):
`META_APP_SECRET`, `OPENCODE_API_KEY`, `NVIDIA_API_KEY`, `NIM_API_KEY`,
`OPENROUTER_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`,
`BUFFER_API_KEY`, `GOHIGHLEVEL_ACCESS_TOKEN`, `APOLLO_API_KEY`,
`BREVO_API_KEY`, `APP_API_SECRET`, `APP_SESSION_SECRET`,
`LEADRAIL_RESEND_API_KEY`, `INBOUND_EMAIL_SECRET`, `INSTAGRAM_APP_SECRET`,
`GOOGLE_CLIENT_SECRET`, `TAVILY_API_KEY`, `SERPAPI_KEY`,
`FILMOPS_RESEND_API_KEY`, `HUGGINGFACE_API_KEY`, `EXA_API_KEY`,
`APIFY_API_TOKEN`, `AI_VAULT_KEY`, `TRANSCRIBE_API_KEY`,
`TRANSCRIBE_FALLBACK_API_KEY`. Non-secret config (`NODE_ENV`,
`NEXT_PUBLIC_SUPABASE_URL`, `AI_TIER_ORDER`, `RESEND_SENDER_EMAIL`, etc.) goes
in `wrangler.jsonc` `vars`, not as secrets.

**5. DNS cutover** — `leadrail.xyz` is already on Cloudflare nameservers
(`kate.ns.cloudflare.com` / `rory.ns.cloudflare.com`), and `app.leadrail.xyz`
is currently a CNAME to `cname.zocomputer.io`. Cutover is a single DNS record
change once the container is verified — no registrar or nameserver migration.

## Open risks — need answers before this is real, not assumed

- **Cold starts**: third-party reports cite ~13s cold start for a fresh
  container instance. If Containers scale to zero between requests, the first
  hit after idle could be materially slower than the always-on Zo process.
  Needs `min_instances` tuning or accepting the latency — not yet decided.
- **Instance sizing**: `standard` (4 GB / 0.5 vCPU) is a guess, not a
  measurement. Needs a real load profile of xlsx/docx/mammoth generation
  before committing.
- **Cost**: Containers require the Workers Paid plan ($5/mo base) plus
  per-second CPU/memory/disk billing. Rough public comparisons put a
  2 vCPU/4 GB always-on container around $100–130/mo; LeadRail's actual spend
  depends on traffic pattern and whether it scales to zero. Not compared here
  against current Zo service cost because I don't have that figure — worth
  checking before committing.
- **`output: 'standalone'` regressions** — RESOLVED 2026-09-03, tested not
  assumed. On branch `spike/cloudflare-containers-standalone` (commit
  `1bbae95`, local only, not merged/deployed): `next build` with
  `output: 'standalone'` succeeded, but `pdfkit` was missing entirely from
  `.next/standalone/node_modules` — it wasn't in
  `serverComponentsExternalPackages`, so webpack inlined its JS but left
  behind its runtime-loaded AFM font data files
  (`node_modules/pdfkit/js/data/*.afm`, used by the standard Helvetica fonts
  `binary-deliverables.ts` actually calls). Reproduced the failure in a
  fully isolated copy of `.next/standalone` (no parent `node_modules`,
  matching what the Docker image would actually contain):
  `require('pdfkit')` failed with `MODULE_NOT_FOUND`. Fix: added `pdfkit` to
  `serverComponentsExternalPackages` alongside the existing four. Rebuilt,
  re-verified in the same isolated setup — `pdfkit` + its 14 `.afm` files now
  present, and a real `Helvetica-Bold` PDF generated successfully (1297
  bytes, no crash). `docx` checked separately: pure JS/XML, no filesystem
  dependency, safe already bundled. Full gate run: `tsc --noEmit` clean,
  `next build` clean, `vitest run` 2950/2956 passing — the 6 failures (4
  files, all `ai-usage-failed-call-estimate.test.ts`-adjacent) reproduced
  identically on unmodified `main`, confirmed pre-existing and unrelated.
  **Not yet tested**: the standalone server hasn't been started and smoke-
  tested end-to-end (still step 1's remaining half — see below), and no
  other route's runtime-loaded assets have been audited the same way
  `pdfkit` was — this class of bug (webpack-inlined JS, orphaned data files)
  could exist elsewhere and wouldn't show up in `tsc`/`next build`/`vitest`.

- **BLOCKER — this Zo sandbox cannot run Docker at all, confirmed
  2026-09-03.** `Dockerfile` and `.dockerignore` were written
  (`node:20-slim` multi-stage build matching the skeleton above), but
  `docker build` fails before it even reads the Dockerfile:
  `dockerd` itself won't start under default settings — creating the
  `docker0` bridge via netlink fails with `operation not permitted`
  (this sandbox runs on gVisor/`runsc`, kernel `4.19.0-gvisor`). Retried
  with `--iptables=false --bridge=none` to skip networking setup entirely
  — the daemon then starts, but both builders fail on the next step:
  BuildKit fails to mount a snapshot (`operation not permitted`), and the
  legacy builder fails with `unshare: operation not permitted`. Confirmed
  the root cause directly: bare `unshare --mount` fails the same way with
  no Docker involved at all. gVisor's sandbox does not allow a nested
  container runtime to create mount/user namespaces — this is a kernel-level
  restriction of the sandbox itself, not a Docker config or permissions
  issue, and there is no flag or workaround for it from inside this
  environment. Cleaned up afterward: `dockerd`/`containerd` killed, no
  daemon left running, nothing else on the box touched.
  **Practical consequence**: "build the image locally" cannot mean *on this
  Zo box*. It needs to happen somewhere Docker actually has kernel
  privileges — the owner's own laptop, a GitHub Actions runner, or
  Cloudflare's own container build path if `wrangler deploy` supports a
  remote/registry build for Containers (needs checking against current
  Cloudflare docs — not assumed here). Steps 2 onward in the order below
  are gated on picking one of those.

## Suggested order of operations

1. **Done (2026-09-03)**: Added `output: 'standalone'`, ran `next build`
   locally — see the resolved risk above for the real bug this caught
   (`pdfkit` font data) and its fix. Standalone server smoke-tested
   end-to-end in isolation (not just built) — `/robots.txt`, `/login`,
   `/welcome`, `/` all responded correctly.
2. **Blocked (2026-09-03) — see the BLOCKER above.** Dockerfile and
   `.dockerignore` are written and committed on
   `spike/cloudflare-containers-standalone`, but the image cannot be built
   or run inside this Zo sandbox — Docker itself cannot start a container
   here (gVisor blocks the namespace operations any OCI runtime needs).
   Building the image and running the same smoke-test pass (Gmail OAuth,
   xlsx/docx generation, SSE stream, `/api/hermes/tick`) needs to happen on
   a machine with real Docker support — not resolved yet, needs the
   owner's decision on where.
3. Install `wrangler`, write `wrangler.jsonc`, `wrangler deploy` to a
   `*.workers.dev` preview URL — do not touch DNS yet. (Also depends on
   step 2's build environment question, since `wrangler deploy` for
   Containers needs a place to build or push the image from.)
4. Migrate secrets via `wrangler secret put`, one at a time.
5. Full smoke test against the preview URL.
6. Only then flip the `app.leadrail.xyz` CNAME. Keep the Zo service running
   and untouched until the Cloudflare version has been live and verified for
   a real stretch — rollback is just reverting the DNS record.

This is scope, not execution — no code or infra has been touched yet.
