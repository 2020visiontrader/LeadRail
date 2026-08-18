# LeadRail — Motion, Interactivity & 3D Plan

> Plan only. No code in this pass. Goal: make the platform, the assistant, and
> every action feel alive, interactive, animated, and (selectively) 3D —
> **without breaking the "Dark operator console" identity in `DESIGN.md`.**

---

## 1. What "interactive, animated, 3D" means here (the interpretation)

Your ask, translated into three distinct layers so we don't conflate them:

1. **Interactive** = every surface responds to intent. Hover, focus, press,
   drag, expand/collapse, and live state changes all have visible, immediate
   feedback. Nothing feels static or "dead" on touch.
2. **Animated** = state *transitions* are motion, not cuts. Things enter, exit,
   reorder, load, and update with purposeful, physics-based movement that
   communicates *what changed and why* — not decoration for its own sake.
3. **3D** = **depth and dimensionality, applied surgically**, not a game engine.
   Two flavours:
   - **"2.5D" depth** (cheap, everywhere-safe): parallax, tilt-on-hover,
     layered shadows, z-translation on elevation, perspective on cards.
   - **True 3D** (expensive, reserved for hero/signature moments): a WebGL
     object — e.g. an animated globe of live outreach, a rotating "engine"
     mesh on the assistant idle state, a 3D pipeline funnel.

**Non-negotiable constraint:** `DESIGN.md` forbids gradients and decorative
illustration and demands one accent per view. Motion/3D must obey the *same*
discipline: token-driven, one signature 3D moment per surface max, motion that
respects `prefers-reduced-motion`, and never at the cost of the dense,
high-signal operator feel. **Premium and calm, not flashy.** If an animation
doesn't clarify state or reward an action, it's cut.

---

## 2. Foundation — the motion system (build once, reuse everywhere)

Before touching screens, establish a shared motion layer so every venture skin
(RetentionRail / FilmOps / RENTAHUB) inherits it identically — same rule as
tokens: layout stays byte-identical, only brand color changes.

### 2.1 Motion tokens (extend `DESIGN.md` + `globals.css`)
A `--motion-*` token set, the animation equivalent of the color/spacing tokens:

- **Durations:** `--motion-instant` 80ms · `--motion-fast` 150ms · `--motion-base`
  250ms · `--motion-slow` 400ms · `--motion-slower` 600ms.
- **Easings:** `--ease-out` (enter), `--ease-in` (exit), `--ease-spring`
  (interactive/press), `--ease-standard` (state change). Named, not ad-hoc.
- **Elevation-on-motion:** z-translate + shadow tier pairing (a card that lifts
  goes `--shadow-1 → --shadow-2` *and* `translateZ`/`translateY`).
- **Stagger:** `--stagger-step` 40ms for list/grid entrance choreography.
- **Reduced-motion:** every token collapses to `0ms`/opacity-only under
  `prefers-reduced-motion: reduce`. Single source of truth, honoured globally.

### 2.2 Library choices
- **`framer-motion`** — primary. Layout animations, presence (enter/exit),
  gestures (hover/tap/drag), springs, shared-layout transitions, scroll-linked
  motion. Covers ~90% of the "interactive + animated" ask.
- **`@react-three/fiber` + `@react-three/drei`** — the *only* true-3D dependency,
  lazy-loaded **per signature surface** (dynamic import, never in the app
  bundle). Used for ≤3 hero moments, not sprinkled.
- **`cobe`** (tiny WebGL globe) or a drei mesh — for the live-outreach globe if
  we want the "map of the world lighting up" moment cheaply.
- Deliberately **no** Lottie/GSAP/particles — avoids bloat and off-brand
  decoration; framer-motion + CSS covers the vocabulary.

### 2.3 Motion primitives (new shared components / hooks)
Wrap the raw libs so screens never touch them directly (keeps it consistent &
swappable):
- `<Motion.FadeIn>` / `<Motion.Stagger>` — entrance choreography.
- `<Motion.Presence>` — mount/unmount transitions (rows, toasts, drawers).
- `<TiltCard>` — 2.5D hover tilt + parallax shadow (the everywhere "3D feel").
- `<Reveal>` — scroll-triggered section entrance.
- `<CountUp>` — animated number rolls for KPI values.
- `<Shimmer>` / `<Skeleton>` — content-shaped loading (replaces bare spinner).
- `useReducedMotion()` — one hook every primitive respects.
- `<Scene3D lazy>` — suspense boundary + fallback for any r3f canvas.

---

## 3. Where it applies — surface by surface

Mapped to the actual components in `src/components` and the `app/` routes.

### 3.1 App chrome (`AppShell`, `Layout`, sidebar, top bar)
- **Sidebar:** active-item indicator becomes a *shared-layout* animated pill
  (slides between items) instead of a hard swap; icons micro-bounce on select.
- **Route transitions:** cross-fade + subtle upward slide on page change
  (`framer-motion` `AnimatePresence` on the route outlet).
- **Venture switch (RetentionRail/FilmOps/RENTAHUB):** animated color-token
  crossfade so re-skinning *feels* like a mode change, not a reload.
- **Top bar:** blur/opacity already token-driven; add scroll-reactive elevation.

### 3.2 The chatbot assistant — the flagship surface (`/assistant`, `AssistantDock`, `AgentConsole`, `ChatAssistant`, `ProgressStages`)
This is where the ask should land hardest. Layered plan:

- **Idle / signature 3D state:** when the assistant is open but idle, a small
  **true-3D "engine" object** (slowly rotating mesh / orb reacting to cursor)
  — the one hero 3D moment of the whole app. Lazy-loaded; collapses to a static
  glyph under reduced-motion or on mobile.
- **Reasoning steps (the "thinking" layer):** upgrade `ProgressStages` into an
  animated **reasoning stream** — steps type/fade in one by one, each with a
  status dot that animates pending → active (pulse) → done (check draw-on),
  connected by an animated vertical "spine" that fills as steps complete. This
  is the single most valuable animation in the product: it makes the AI feel
  like it's *working*, transparently.
- **Streaming responses:** token-by-token reveal with a live caret; tool-call
  cards animate in as nested "action" chips (see 3.3).
- **Message entrance:** user + assistant bubbles spring in with stagger;
  auto-scroll is eased, not jumpy.
- **Assistant dock:** open/close is a spring expand from its trigger (shared
  layout), not a display toggle; a subtle "listening/thinking" ambient pulse on
  the trigger when work is in flight.
- **Input affordances:** send button morphs into a stop/loading state; focus
  ring animates in per token.

### 3.3 Actions, loading states & reasoning (`ProgressStages`, `LoadingSpinner`, `Toast`, `Approvals`, tool cards)
- **Loading:** replace bare `LoadingSpinner` with **content-shaped skeletons**
  (`<Shimmer>`) for tables/cards, and the animated stage-walker for multi-step
  work. Bare spinners only for <300ms unknowns.
- **Tool/agent actions:** each action (send email, enrich lead, run search,
  generate ad) renders an **action card** that animates through
  queued → running (progress) → success/failure, with the result count rolling
  up. Ties the assistant's reasoning to visible platform effects.
- **Optimistic UI:** row status changes (New → Outreaching → Replied →
  Qualified) animate the badge color/label transition + a brief row highlight,
  so pipeline movement is *felt*.
- **Toasts:** spring in from edge, progress-bar auto-dismiss, stack with layout
  animation.
- **Approvals:** approve/reject swipe + card exit animation.

### 3.4 Data surfaces (`DataTable`, `KPICard`, `Chart`, `Analytics`, `Budgets`, pipeline/kanban)
- **KPI tiles:** `<CountUp>` value rolls, trend arrow draws in, `<TiltCard>`
  2.5D hover. Sparkline animates its path on mount.
- **Tables:** row enter/exit + reorder via layout animation (sort/filter feels
  physical); expandable row drawers spring open; new leads flash-highlight in.
- **Charts:** path draw-on, bar grow-up, tooltip spring; on `Analytics`, a
  **live pipeline funnel** — optionally a **3D funnel** as a signature moment.
- **Live outreach map/globe:** the second reserved true-3D moment — a globe or
  map where outreach activity lights up geographically in real time.

### 3.5 Forms, inputs, modals, drawers (`Forms`, `Input`, `Modal`, `Drawer`, `Dropdown`, `CommandBar`)
- **Modals/drawers:** scrim fade + content spring (scale/slide), not instant.
- **Command bar:** results stagger in, active row animates, open/close springs.
- **Inputs:** animated focus ring, label float, inline validation shake on
  error, success check draw-on.
- **Dropdowns/menus:** origin-aware scale-in.

### 3.6 Empty & onboarding states (`EmptyState`)
- Gentle looping ambient motion (breathing glyph / drifting particles kept
  strictly on-brand) so empty screens feel intentional, plus a spring-in CTA.
- First-run: a subtle guided reveal sequence highlighting the primary action.

---

## 4. The 3D discipline (so it stays premium, not gimmicky)

**Budget: at most 3 true-3D moments in the entire app.** Candidates, pick the
strongest:
1. **Assistant idle engine/orb** (strongest — it's the brand's "intelligence").
2. **Live outreach globe** on the dashboard/analytics.
3. **3D pipeline funnel** in analytics.

Rules:
- Every r3f canvas is **lazy-loaded** (dynamic import, Suspense fallback), never
  in the initial bundle, and **disabled on mobile + reduced-motion** (static
  fallback image/glyph).
- 3D obeys brand tokens — mesh/material colors come from
  `--brand-secondary` / `--brand-accent`, background stays `--bg-canvas`. No
  off-palette lighting.
- Everywhere else, "3D" means **2.5D depth** via `<TiltCard>`, parallax, and
  layered token shadows — the safe, cheap dimensionality that scales to the
  whole app.

---

## 5. Guardrails (carry the DESIGN.md ethos into motion)

- **Performance budget:** 60fps target; animate only `transform`/`opacity`;
  no layout-thrashing properties. 3D scenes throttle when tab hidden.
- **Accessibility:** `prefers-reduced-motion` fully honoured — all motion tokens
  collapse to opacity/instant; 3D → static. `aria-live` on reasoning/loading
  stays (already present in `ProgressStages`).
- **Restraint:** one signature motion per surface, one 3D moment per surface
  max; motion must clarify state or reward action or it's removed.
- **Consistency:** all motion flows through §2 primitives/tokens so the three
  venture skins animate identically — re-theme = swap brand tokens only.
- **No off-brand decoration:** no gradients, no stock Lottie, no particle
  confetti in the operator UI (empty-state ambient motion is the one exception,
  kept minimal and token-colored).

---

## 6. Suggested phasing (each phase shippable on its own)

- **Phase 0 — Foundation:** motion tokens in `DESIGN.md` + `globals.css`,
  `framer-motion` install, the §2.3 primitives/hooks, `useReducedMotion`.
  *No visible change yet; unlocks everything.*
- **Phase 1 — Assistant reasoning + streaming:** the animated reasoning stream,
  streaming reveal, action cards, dock spring. *Highest perceived value.*
- **Phase 2 — Actions & loading everywhere:** skeletons, optimistic status
  transitions, toasts, approvals, table enter/exit/reorder.
- **Phase 3 — Data delight:** KPI count-ups, chart draw-ons, TiltCard depth,
  route/sidebar/venture-switch transitions.
- **Phase 4 — Signature 3D:** the ≤3 reserved WebGL moments (assistant engine →
  globe → funnel), lazy-loaded, mobile/reduced-motion fallbacks.
- **Phase 5 — Polish & audit:** performance pass, reduced-motion QA across all
  three skins, cut anything that doesn't earn its place.

---

## 7. Open questions for you (answer to lock scope)

1. **3D intensity:** are you picturing the true-WebGL hero moments (§4), or is
   rich 2.5D depth + motion everywhere enough? (Cheaper, faster, safer.)
2. **Signature 3D pick:** if we do WebGL, which of the three — assistant engine,
   live globe, or funnel — is the one you most want?
3. **Scope:** all three venture skins at once, or prove it on one
   (RetentionRail) first, then propagate?
4. **Reduced-motion default:** premium-heavy for everyone, or conservative by
   default with a "high motion" toggle in settings?
