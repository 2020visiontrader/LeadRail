# PACKET 11.2 — Public landing page (interactive, SEO + GEO)

**Tier:** C (public surface, no data access) · **Branch:** `feat/copilot-remediation`
**Depends on:** 11.1 recommended first — the footer links the legal pages it updates.

---

## The problem

There is no landing page. `app/page.tsx` is the authenticated dashboard, and
`middleware.ts` redirects unauthenticated visitors from `/` straight to `/login`.
A stranger hitting the domain sees a login form: no explanation, no signup path,
no route to the legal pages except by typing the URL.

---

## Reference: Legora and Harvey — take the interaction, reject the proof

Both were reviewed (2026-08-16). **Their strongest elements are social proof
LeadRail does not have**, and copying that structure would force fabrication:

| Their element | Verdict |
|---|---|
| Customer logo carousel (Harvey: 23 logos) | ❌ **Do not build.** No customers to name. |
| Testimonials with headshots (Harvey: 3) | ❌ **Do not build.** |
| Video case studies (Harvey: 7) | ❌ **Do not build.** |
| Impact metrics ("200k+ lawyers", "30% fewer non-billable hours", "$2.0M/100 lawyers") | ❌ **Do not build.** No measured data exists. |
| Certification row (SOC 2 II, ISO 27001, GDPR, HIPAA, ISO 42001) | ❌ **Do not build.** Excalix holds none of these. Claiming them is fraud. |
| **Tabbed capability explorer** (Legora: 7 architecture tabs; Harvey: 6 use-case tabs) | ✅ **Build this.** |
| **Scroll-revealed product sections** | ✅ Build, lightly. |
| **"Book a demo" CTA repeated 3+ times** | ✅ Adopt — see CTA honesty below. |

An empty logo carousel or a placeholder testimonial is worse than omitting the
section. **If a section would need invented material, the section does not
ship.**

### What LeadRail has that neither of them shows

Both sites *describe* agentic work; neither *demonstrates* it on the landing
page. LeadRail's live step trace — `thought → tool → observation → streamed
answer`, with an approval card interrupting anything that spends money — is a
real, visible differentiator. **That is the interactive centrepiece.**

Note Legora's tab taxonomy (LLMs · Agentic Harness · Data & Integrations ·
Context & Knowledge · Capabilities · Interfaces · Security & Governance) maps
almost 1:1 onto LeadRail's real architecture: model router (`lib/ai/router.ts`),
agent loop, integrations, grounding + durable memory, the capability registry,
and the approval gate. Borrow the *shape* because the substance genuinely exists.

---

## The interactive centrepiece — and the honesty rule that governs it

Build a **scripted replay** of a real assistant turn: steps appear in sequence,
a tool step resolves to a check, an approval card appears and waits, the answer
streams in as markdown.

**It must be unmistakably a replay, not a live model.** Label it (e.g. "Example
run"). It must not accept free-text input that appears to produce real AI output.
A visitor must never be able to reasonably believe they are talking to the
product when they are not. Deceptive demos on a named company's site are a
consumer-protection problem, not a growth tactic.

Source the replay from the real event shape in `lib/agent/loop.ts`
(`AgentEvent`: `thought`, `tool`, `observation`, `final_delta`, `final`,
`needs_approval`) so it depicts what the product actually does. Reuse the visual
language of `src/components/AgentConsole.tsx` — the pulsing dot resolving to a
check, the approval card — so the demo looks like the app.

Respect `prefers-reduced-motion`: render the completed end state, no animation.

---

## Architecture constraint — this decides SEO and GEO

**Content must be server-rendered. Interactivity is a client island on top.**

If the copy only exists after JS runs, AI answer engines and many crawlers will
not see it, and GEO fails outright. So:

- The page is a **server component**. All copy, headings, FAQ text and structured
  data render in the initial HTML.
- Interactive parts are **small `'use client'` islands** (the tab explorer, the
  replay). Tabs must render the first tab's content server-side and swap on
  click — not fetch or generate it.
- **No new dependencies.** No animation library, no carousel package, no UI kit,
  no font package. CSS transitions and React state only. Heavy JS also costs
  Core Web Vitals, which costs ranking.

---

## SEO requirements

1. **Metadata** via the App Router `metadata` export (follow `app/privacy/page.tsx`):
   unique `title` (~55–60 chars), `description` (~150–160), `canonical`.
2. **OpenGraph + Twitter card**, including an OG image. If no real image asset
   exists, generate one from the design system rather than shipping a broken URL.
3. **JSON-LD structured data**, server-rendered:
   - `Organization` — Excalix, Toronto, Ontario, Canada
   - `SoftwareApplication` — name, description, category. **Omit `aggregateRating`
     and `offers` entirely**; fabricating either is both a Google penalty and a
     false statement.
   - `FAQPage` — see GEO below.
4. **`app/sitemap.ts` and `app/robots.ts`** (Next 14 conventions). Include the
   public pages only — `/welcome`, `/privacy`, `/terms`, `/data-deletion`.
   `robots.ts` must **disallow** the authenticated app surface.
5. **Semantic structure:** one `<h1>`, ordered `<h2>`/`<h3>`, real landmarks
   (`<header>`, `<main>`, `<footer>`), descriptive `alt` on every image.
6. **Performance:** no layout shift from the replay (reserve its height), lazy
   images, no blocking JS.

## GEO requirements (generative engine optimization)

Getting cited by AI answer engines rewards different things than blue links.

1. **Unambiguous entity definition in the first 100 words of body copy** — one
   sentence stating what LeadRail is, who operates it (Excalix, Toronto), and who
   it is for. AI engines quote definitional sentences; make one quotable.
2. **Self-contained factual statements.** Each key claim should stand alone
   without its surrounding paragraph, because that is how it gets extracted.
3. **An FAQ section with direct question → answer pairs**, marked up as
   `FAQPage` JSON-LD. **Neither Legora nor Harvey has one** — this is the
   clearest available advantage, not a thing to copy.
   Cover at least: What is LeadRail? Who is it for? What can the assistant
   actually do? Does it send anything without approval? Which platforms does it
   connect to? Who operates it? Where is data stored?
   Every answer must be true of the shipped product.
4. **Add `public/llms.txt`** — an emerging convention describing the site for
   language models. Plain, factual, no marketing voice.
5. **Crawlability:** verify the copy is present in `view-source`, not just after
   hydration.

---

## Keyword strategy

### Positive — target these

Group by intent; write copy that earns them honestly rather than stuffing.

- **Category:** AI CRM, agentic marketing platform, AI marketing assistant,
  marketing operations platform
- **Function:** lead generation software, lead enrichment, outbound sequences,
  Meta ads management, social media scheduling, multi-brand marketing
- **Differentiator (highest value — LeadRail genuinely owns these):**
  human-in-the-loop AI marketing, AI with approval workflow, AI that shows its
  work, auditable AI agent, marketing AI that asks before spending
- **Long-tail:** "AI assistant that manages ad campaigns", "CRM with AI agent
  approval", "marketing platform for multiple brands"
- **Geo:** Toronto / Canada — relevant to entity and jurisdiction, and worth a
  natural mention. Do not fabricate a local-business presence.

### Negative — two distinct senses, both required

**(a) Paid-search exclusions** — deliver as a list for future Google Ads, in a
comment block or a short `docs/` note:
`free`, `crack`, `torrent`, `nulled`, `open source`, `github`, `tutorial`,
`course`, `jobs`, `salary`, `internship`, `template`, `resume`, plus wrong
verticals (`legal AI`, `harvey`, `legora`, `medical`) and competitor brand terms
the product cannot serve.

**(b) On-page terms to AVOID — this one has compliance weight.**

Excalix operates from Canada, so **CASL** applies to its own marketing and
frames how the product may be positioned. Do not use, and do not optimise for:

> `cold email at scale` · `bulk email blast` · `email scraper` · `scrape leads` ·
> `unlimited sending` · `no opt-in needed` · `fully autonomous` · `set and forget` ·
> `hands-off outreach` · `guaranteed deliverability`

Two independent reasons: they attract spam-adjacent users who will get the
platform's sending domains blocked, and they market a consent posture the
product does not implement — packet 11.1 records that consent-of-record does not
exist in the codebase. **Positioning must not write a cheque compliance cannot
cash.**

Lead instead on control, approval, and auditability. That is both true and the
higher-value positioning.

---

## Routing — deliberately the low-risk path

**Do NOT move the dashboard.** Relocating `app/page.tsx` would touch every
internal link and redirect for no benefit here.

1. Create `app/welcome/page.tsx`.
2. Add `/welcome` to `PUBLIC_PAGES` in `middleware.ts`.
3. Change the unauthenticated redirect for `/` **only** — `/login` → `/welcome`.
   Every other unauthenticated route still goes to `/login`.

`/login` stays directly reachable and unchanged. An authenticated user hitting
`/` still gets the dashboard with no extra hop.

**Read `middleware.ts` carefully — it is the auth boundary for the whole app.**
The change is one redirect target for one path. If you find yourself
restructuring the matcher or `PUBLIC_API`, STOP and report.

---

## Content — claims that are true today

Verify each against the repo before writing:

- Marketing and CRM platform: leads, enrichment, pipeline, outreach sequences, ad
  campaigns, social publishing.
- An assistant that operates the platform in plain language and **shows every
  step**.
- **Approval before anything that spends money or reaches a real person** —
  enforced server-side (packet 0.1), audited, and applies to machine callers too
  (packet 0.3). The strongest honest claim on the page. Lead with it.
- Durable memory across conversations (packet 1.1).
- Multi-venture: one account, several brands.
- Connects to Meta, Instagram, Threads, Buffer, Notion, Google Drive, email.

**Do not claim** SOC 2, ISO, HIPAA, "GDPR compliant", uptime figures, customer
counts, or data residency — 11.1 is still establishing what is true there.

**CTA honesty:** if there is no self-serve signup (there is not — `/login` only),
the CTA must be "Book a demo" or "Request access", never "Start free" or "Sign up
free".

## Design

Reuse the design system: CSS variables from `app/globals.css`
(`--bg-surface`, `--text-primary`, `--border-default`, `--brand`,
`--shadow-card`), documented in `DESIGN.md`. The page should look like the
product. Responsive, no horizontal scroll at 375px, keyboard-accessible tabs
(arrow keys, correct ARIA), sufficient contrast in both themes.

## Files

**Create:** `app/welcome/page.tsx`, its client island component(s) under
`src/components/`, `app/sitemap.ts`, `app/robots.ts`, `public/llms.txt`
**Modify:** `middleware.ts` (two lines)

No changes to `app/page.tsx`, `app/login/`, or any API route.

## Acceptance criteria

1. `./node_modules/.bin/tsc --noEmit` and `npm run build` pass.
2. Unauthenticated `/` → `/welcome`; `/welcome` renders with no session.
3. Unauthenticated `/leads` still → `/login`; `PUBLIC_API` untouched.
4. Authenticated `/` still renders the dashboard, no added redirect.
5. All copy, FAQ text and JSON-LD present in server HTML — verify by disabling JS
   or reading the SSR output, and paste the evidence.
6. Zero new dependencies; `package.json` unchanged.
7. `robots.ts` disallows authenticated routes; `sitemap.ts` lists only the four
   public pages.
8. JSON-LD validates and contains no `aggregateRating` or `offers`.
9. No invented customers, metrics, testimonials, certifications, or pricing.
10. The demo is labelled as an example and accepts no free-text input implying
    live AI.
11. No banned negative-keyword phrase appears anywhere in the copy.
12. No horizontal scroll at 375px; `prefers-reduced-motion` respected.

## Reviewer checklist (human — do not self-certify)

- [ ] Every claim is true of the shipped product today.
- [ ] The approval-gate claim is accurate, not overstated.
- [ ] Auth boundary intact — private routes still redirect to `/login`.
- [ ] Nobody could mistake the replay for a live model.
- [ ] Copy avoids every CASL-adjacent phrase in the negative list.
- [ ] Structured data claims nothing Excalix cannot evidence.
- [ ] Page looks like the product; no off-system colours or fonts.
