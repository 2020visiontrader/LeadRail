# LeadCRM Security Remediation Plan

Status legend: [ ] todo · [~] in progress · [x] done

## Root cause
Authentication exists (session HMAC + bearer), but **authorization does not**: API routes never read the session, so nothing is scoped to the caller's `account_id`. Every table has `account_id`; the DB uses the service-role key (RLS bypassed), so app-layer scoping is the only boundary.

## Phase 1 — Critical (close IDOR + fail-closed auth) — ✅ DONE
- [x] `lib/http.ts`: add `requireSession(request)` → returns `{ session }` or `{ error: 401 }`.
- [x] `lib/session.ts`: fail-closed — throw if `APP_SESSION_SECRET` unset in production (no dev fallback in prod).
- [x] `lib/http.ts` `requireAuth`: fail-closed in production if `APP_API_SECRET` unset (keep no-op only in dev).
- [x] Scope by-id data fns with `accountId`:
  - `lib/db.ts`: `getContact`, `updateContact`, `deleteContact`, `findContactByEmail`.
  - `lib/crm.ts`: `getCompany/updateCompany/deleteCompany`, `getDeal/updateDeal/moveDealStage/deleteDeal`, `updateActivity/deleteActivity`, `deleteNote`, `scoped()` update/remove, `getCampaignMembers`, `getCampaignAssets`, `getContactCompanyRoles`, `getContactAliases`.
- [x] Convert user-facing routes from bearer `requireAuth` → cookie `requireSession`, deriving `accountId` from session (never from client body/query):
  - `[id]` routes: leads, deals, companies, cases, notes, activities, partners, knowledge, inbox, templates, sequences, outreach.
  - list/create routes: leads, deals, companies, activities, notes, overview, brands, territories, campaign-members, pipeline, entitlements.
  - verify brand ownership when `brandId` supplied (brand.account_id === session.accountId).
- [x] `middleware.ts`: remove broad public prefixes (`/api/social/ghl`, `/api/social/buffer`, `/api/social/meta/insights`); keep only `login`, `webhooks`, `hermes/tick`, `social/meta/callback` public.
- [x] Social GET routes (ghl/accounts, ghl/locations, buffer/channels, meta/insights): require session.

## Phase 2 — High — ✅ mostly done
- [x] `.gitignore`: add `.env.production`; confirm not tracked; note key rotation.
- [x] Meta webhook env fix: code reads `META_VERIFY_TOKEN` but env defines `META_WEBHOOK_VERIFY_TOKEN`; align.
- [x] Webhook signatures fail-closed in production if secret unset (meta/brevo/postiz).
- [~] AI generate routes: `accountId` now derived from session (done); per-account entitlement/credit enforcement still TODO.
- [x] `createContact`/insert paths: force `account_id` from session, verify `brand_id` ownership, ignore client-supplied.

## Phase 3 — Medium
- [ ] Login rate limiting / lockout.
- [ ] Standardize validation (zod) across all mutating routes.
- [ ] Webhook idempotency keys.
- [ ] CSRF consideration for cookie-auth POSTs.

## Verification
- `npx tsc --noEmit` clean after each phase.
- `next build` succeeds.
- Manual: cross-tenant GET/PATCH/DELETE by id returns 404/401; same-tenant works.
