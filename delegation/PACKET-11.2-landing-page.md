# PACKET 11.2 — Public landing page

**Tier:** C (public surface, no data access) · **Branch:** `feat/copilot-remediation`
**Depends on:** 11.1 recommended first (the footer links to the legal pages it updates).

---

## The problem

There is no landing page. `app/page.tsx` is the authenticated dashboard — KPI
cards, charts, the CommandBar — and `middleware.ts` redirects unauthenticated
visitors from `/` straight to `/login`. A stranger who hits the domain sees a
login form with no explanation of what the product is, no signup path, and no
route to the legal pages except by typing the URL.

## Routing approach — deliberately the low-risk one

**Do NOT move the dashboard.** Relocating `app/page.tsx` to `/dashboard` would
touch every internal link and every redirect, for no benefit to this packet.

Instead:

1. Create the landing page at its own route, e.g. `app/welcome/page.tsx`.
2. Add `/welcome` to `PUBLIC_PAGES` in `middleware.ts`.
3. Change the unauthenticated redirect target for `/` **only** — from `/login` to
   `/welcome`. Every other unauthenticated route keeps redirecting to `/login`
   exactly as today.

`/login` must remain directly reachable and unchanged. An authenticated user
hitting `/` must still get the dashboard, with no extra redirect hop.

**Read `middleware.ts` carefully before touching it.** It is the auth boundary
for the entire app. The change is one redirect target for one path. If you find
yourself restructuring the matcher or the `PUBLIC_API` list, STOP and report —
that is out of scope and dangerous.

## Content

Honest positioning only. **Do not invent** customer names, logos, testimonials,
metrics, case studies, pricing, funding, team size, or an SLA. Fabricated social
proof on a real company's public site is a legal and reputational problem, not a
copywriting shortcut. If a section would need invented material, leave the
section out.

What is true and can be said (verify each against the repo before writing):

- A marketing and CRM platform: leads, enrichment, pipeline, outreach sequences,
  ad campaigns, and social publishing in one place.
- An AI assistant that operates the platform in plain language and **shows every
  step it takes** — the live step trace is real and is a genuine differentiator.
- **Approval before anything that spends money or reaches a real person.** This
  is real, enforced server-side (packet 0.1), and audited. It is the strongest
  honest claim on the page — lead with it.
- Multi-venture: one account, several brands.
- Connects to Meta, Instagram, Buffer, Notion, Google Drive, and email providers.

Do not claim SOC 2, ISO, GDPR "compliance", uptime numbers, or anything about
data residency — 11.1 is still establishing what is true there.

Operator: **Excalix, Toronto, Ontario, Canada.** Footer must link `/privacy`,
`/terms`, and `/data-deletion`.

## Design

Reuse the existing design system. `app/globals.css` defines the CSS variables the
app uses (`--bg-surface`, `--text-primary`, `--border-default`, `--brand`,
`--shadow-card`); `DESIGN.md` documents the system. The landing page should look
like the product, not like a different company's site.

- Server component. No `'use client'` unless something genuinely needs
  interactivity — it almost certainly does not.
- **No new dependencies.** No animation library, no UI kit, no font package.
- Responsive: single column on mobile, no horizontal scroll at 375px.
- Respect the existing light/dark treatment the app already uses.
- Accessible: real landmarks (`<header>`, `<main>`, `<footer>`), one `<h1>`,
  sufficient contrast, keyboard-reachable links.
- Add `metadata` (title, description) the way `app/privacy/page.tsx` does.

## Files

**Create:** `app/welcome/page.tsx`
**Modify:** `middleware.ts` (two lines: `PUBLIC_PAGES` entry, and the `/`
unauthenticated redirect target)

Nothing else. No changes to `app/page.tsx`, `app/login/`, or any API route.

## Acceptance criteria

1. `./node_modules/.bin/tsc --noEmit` and `npm run build` pass.
2. Unauthenticated `/` → `/welcome`, and `/welcome` renders without a session.
3. Unauthenticated `/leads` (or any other private route) still → `/login`.
4. Authenticated `/` still renders the dashboard, with no added redirect.
5. `/login` still directly reachable and unchanged.
6. Footer links to `/privacy`, `/terms`, `/data-deletion` and all three resolve.
7. Zero new dependencies; `package.json` untouched.
8. No invented customers, metrics, testimonials, pricing, or certifications.
9. No horizontal scroll at 375px width.

## Reviewer checklist (human — do not self-certify)

- [ ] Every claim on the page is true of the shipped product today.
- [ ] The approval-gate claim is described accurately, not overstated.
- [ ] Auth boundary intact: private routes still redirect to `/login`, and the
      `PUBLIC_API` list is untouched.
- [ ] No signup flow is implied that does not exist — if there is no
      self-serve signup, the CTA must be honest about that.
- [ ] Page looks like the product; no off-system colours or fonts.
