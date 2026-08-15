# DESIGN.md — Multi-Venture Lead CRM

> Dark operator console — a dense, high-signal command surface where teal data glows against near-black navy and a single hot accent marks the one action that matters.

**Theme:** dark
**Applies to:** Outreach Dashboard, the operator Settings console, and all Phase 1+ screens across RetentionRail, FilmOps, RENTAHUB.

The CRM is one product with three venture skins. Structure, spacing, type and component anatomy are **identical** across ventures; only the brand tokens change. Never fork layout per venture.

> **Implementation note (2026-08):** the shipped `app/globals.css` carries these
> roles under a different, pre-existing variable *naming* convention that many
> components already depend on — `--ink` / `--ink-hover` / `--ink-fg` (= this
> doc's `--brand-accent` primary-action role), `--brand` / `--brand-hover` /
> `--brand-soft` (= this doc's `--brand-secondary` data/focus role), `--accent`
> (destructive/error only, not a primary-action color), plus `--bg-canvas` /
/`--bg-surface` / `--bg-raised` / `--text-primary` / `--text-secondary` /
> `--text-muted` / `--border-default` / `--border-strong` which map 1:1 to the
> names below. This refresh pass **kept those names** (renaming would break
> every consuming page) and pulled their dark-mode **values** to match the
> palette in this document. Treat the mapping table as authoritative for
> "what token do I reach for," and the CSS variable names above as "what it's
> actually called in code."

---

## Tokens — Colors

### Global (venture-independent)

| Name | Value | Token | Role |
|------|-------|-------|------|
| Canvas | `#0A0F1F` | `--bg-canvas` | Page background. The only full-page background. |
| Surface | `#0F1A2E` | `--bg-surface` | Cards, panels, sidebar, header. One level above canvas. |
| Surface Raised | `#16233D` | `--bg-raised` | Cards nested inside a surface; table hover rows. |
| Text Primary | `#FFFFFF` | `--text-primary` | Headings, values, lead names. |
| Text Secondary | `#A0AEC0` | `--text-secondary` | Labels, meta, column headers, inactive nav. |
| Text Muted | `#6B7B93` | `--text-muted` | Timestamps, hex captions, hint text only. |
| Border | `rgba(255,255,255,0.08)` | `--border-default` | All card and header borders. |
| Border Strong | `rgba(255,255,255,0.12)` | `--border-strong` | Input borders, dividers, outlined cards. |
| Success | `#10B981` | `--success` | Qualified status, positive trend. |
| Error | `#EF4444` | `--error` | Dead status, validation, destructive. |
| Warning | `#F59E0B` | `--warning` | Replied status, needs-attention. |
| Info | `#3B82F6` | `--info` | New status, neutral system messages. |

### Venture brands

| Venture | Primary | Secondary | Accent | Roles |
|---------|---------|-----------|--------|-------|
| RetentionRail | `#0F1A2E` | `#00D4B4` | `#FF6B2B` | primary = chrome (header/sidebar), secondary = data viz + focus ring, accent = primary action |
| FilmOps | `#1A1A1A` | `#FF9500` | `#FFBF47` | same roles |
| RENTAHUB | `#0F1520` | `#00C2A8` | `#FF6B4A` | same roles |

Every color above has exactly one job. Accent is reserved for the single primary action per view — if two buttons on a screen are accent, one is wrong.

Status → color map (fixed, never re-map):
`New` → Info · `Outreaching` → brand secondary · `Replied` → Warning · `Qualified` → Success · `Dead` → Error.
Status badges use the color at `22` alpha suffix for fill (`#10B98122`) and full value for text.

---

## Tokens — Typography

One family: **Inter** (400/500/600/700). Monospace `Menlo, monospace` for hex values, IDs and numeric token labels only.

| Role | Size | Weight | Line height | Letter spacing | Used for |
|------|------|--------|-------------|----------------|----------|
| Display / H1 | 32px | 700 | 1.15 | -0.5px | Page title only, once per screen |
| Heading / H2 | 24px | 600 | 1.25 | -0.25px | Section headings |
| Subhead / H3 | 18px | 600 | 1.35 | 0 | Card group titles, modal titles |
| Card title | 15px | 600 | 1.4 | 0 | Lead name, panel headers |
| Body large | 16px | 400 | 1.6 | 0 | Intro/description paragraphs |
| Body | 14px | 400 | 1.5 | 0 | Default UI text, buttons |
| Small | 13px | 400 | 1.45 | 0 | Nav items, inputs, dense controls |
| Caption | 12px | 400 | 1.4 | 0 | Labels, table cells, meta |
| Micro | 11px | 600 | 1.3 | 0.5px | Badges, KPI labels, trends |
| Overline | 12px | 600 | 1.3 | 1px, uppercase | Section eyebrows |

KPI values: 24px/700. Never go below 11px anywhere.

---

## Tokens — Spacing and Shapes

**Spacing scale (4px base):** 2, 4, 8, 12, 16, 24, 32, 48, 64, 96 → `--space-0-5` … `--space-24`.
Use 16 for intra-card padding rhythm, 24 for card padding, 16 for grid gaps, 96 between page sections.

**Border radius per element**

| Element | Radius | Token |
|---------|--------|-------|
| Button sm | 4px | `--radius-sm` |
| Button md/lg, input, select | 6px | `--radius-md` |
| Card, panel, table container | 12px | `--radius-lg` |
| Nested card / KPI tile | 10px | `--radius-card-sm` |
| Framed template shell | 14px | `--radius-xl` |
| Badge, avatar, toggle, pill, tag | 9999px | `--radius-full` |

**Shadows**

| Token | Value | Allowed on |
|-------|-------|-----------|
| `--shadow-1` | `0 2px 8px rgba(0,0,0,0.12)` | Hover state of interactive cards |
| `--shadow-2` | `0 4px 12px rgba(0,0,0,0.15)` | Elevated cards |
| `--shadow-3` | `0 8px 24px rgba(0,0,0,0.18)` | Dropdowns, popovers |
| `--shadow-4` | `0 16px 48px rgba(0,0,0,0.25)` | Modals, framed dashboard shell |
| `--focus-ring` | `0 0 0 3px <secondary>22` | Focused inputs only |

**Layout constants:** page max-width `1440px`, page padding `32px`, sidebar `200px`, top bar `64px` (min-height, wraps on narrow), sub-header `56px`, grid gap `16px`.

---

## Components

Colors below are token names. All transitions `150ms ease`.

**Primary button** — bg `--brand-accent`, text `--bg-canvas`, 14px/600, padding 10px 16px, height 40px, radius 6px, no border. Hover: brightness 1.08. Active: brightness 0.94. Disabled: opacity 0.5, `cursor:not-allowed`. Loading: 14px spinner in `--bg-canvas`, label stays.
Sizes: sm 32px (6px 12px, 12px, radius 4px) · md 40px · lg 48px (13px 20px, 16px).

**Secondary button** — transparent bg, 1px border `--brand-secondary`, text `--brand-secondary`, same metrics as primary. Hover: bg `<secondary>14`.

**Tertiary button** — transparent, no border, text `--text-secondary`. Hover: text `--text-primary`.

**Danger button** — bg `--error`, text `#FFFFFF`.

**Nav bar (top)** — height 64px, bg `rgba(10,15,31,0.92)` + `backdrop-filter: blur(8px)`, bottom border `--border-default`, sticky, `z-index:50`. Wordmark 16px/700 left; venture pill switcher right in a `--radius-full` container, bg `--bg-surface`, 4px padding; active pill bg `--brand-accent`, text `--bg-canvas`, 12px/600; inactive text `--text-secondary`. Header contents must `flex-wrap` and pills must `flex-shrink:0` — nav links must never overlap the switcher.

**Sidebar** — 200px, bg `--brand-primary`, right border `--border-default`, 20px 12px padding. Item: 13px, 9px 12px, radius 6px, `--text-secondary`. Active: bg `<accent>22`, text `--brand-accent`, weight 600, 6px leading dot.

**Card** — bg `--bg-surface`, 1px `--border-default`, radius 12px, padding 24px. Variants: *elevated* adds `--shadow-2` and drops the border; *outlined* uses `--border-strong`; *nested* uses `--bg-raised` + radius 10px + 16px padding.

**Input** — bg `--bg-canvas`, 1px `--border-strong`, radius 6px, padding 10px 12px, 13px, text `--text-primary`, placeholder `--text-muted`. Focus: border `--brand-secondary` + `--focus-ring`. Error: border `--error` + 11px `--error` message 4px below.

**Badge** — 11px/600, padding 4px 10px, radius full, fill `<color>22`, text `<color>` from the status map. No borders, no icons.

**Section header** — Overline in `--brand-accent` (12px/600/1px uppercase), then H1 or H2, then optional 16px `--text-secondary` description at max 640px. 24px below before content.

**Table** — 12px, transparent bg inside a card. Header row `--text-secondary` 12px/600, 8px 10px padding, no bottom border. Body rows separated by 1px `rgba(255,255,255,0.06)` top borders; cell padding 10px. First cell `--text-primary`, others `--text-secondary`. Row hover `--bg-raised`.

**KPI tile** — nested card; caption label 11px `--text-secondary`, value 24px/700 `--text-primary`, trend 11px in `--success`/`--error` with ↑/↓.

**Footer** — none in app chrome; app is full-height with no page footer.

---

## Surfaces and Elevation

Canvas `#0A0F1F` → Surface `#0F1A2E` (cards, chrome) → Raised `#16233D` (nested tiles, hover rows) → Overlay (modals/dropdowns on Surface + `--shadow-3/4` + scrim `rgba(10,15,31,0.7)`).

Shadows are allowed **only** on: elevated cards, dropdowns/popovers, modals, and the framed dashboard shell. Never on inputs, badges, buttons, table rows, sidebar or the top bar (the top bar uses blur, not shadow).

---

## Layout

- Page: `max-width:1440px`, centered, `padding:48px 32px 120px`.
- App shell: sticky top bar (64px) → optional venture sub-header (56px) → 200px sidebar + fluid content (24px padding).
- Section rhythm: 96px between major sections, 24px from heading to content, 16px between sibling cards.
- Grids: KPI row = 5 equal columns; card rows = 2 or 3 equal columns; detail split = `1.4fr 1fr` with the table on the wide side.
- Always `display:flex` / `grid` + `gap`. Never margin-space siblings or rely on inline whitespace.
- Everything aligns to the 32px page gutter; card content aligns to a single 24px inner gutter.
- Numeric columns right-align; all text columns left-align.

---

## Do's

1. Use exactly one `--brand-accent` element per view — the primary action.
2. Put every card on `--bg-surface` with a 1px `--border-default`, radius 12px, 24px padding.
3. Take status colors from the fixed status map; never invent a status color.
4. Keep body text at 14px and captions at 12px; label + value is the standard pairing.
5. Use `<color>22` alpha fills for all tinted backgrounds (badges, active nav, tags).
6. Use 4px-multiple spacing values only; 16px is the default gap.
7. Re-theme by swapping the three brand tokens — layout stays byte-identical across ventures.
8. Give focused inputs the `--focus-ring`, and give every interactive element a visible hover state.

## Don'ts

1. Don't use gradients anywhere — flat fills only.
2. Don't introduce a fourth surface level or a background outside the three defined values.
3. Don't put radius above 12px on anything except the framed shell (14px) and pills/avatars (full).
4. Don't use accent for text, borders, or decoration — it is an action and eyebrow color only.
5. Don't shadow inputs, badges, buttons, or table rows.
6. Don't add a second typeface; don't use Inter below 11px; don't use monospace for prose.
7. Don't use emoji or decorative illustration in the app UI.
8. Don't stack more than two font weights in one card (600 for label/title, 400 or 700 for value).
9. Don't add borders to badges or fills to table headers.
10. Don't make the venture skins structurally different from each other.

---

## Agent Quick Reference

```
text            #FFFFFF
text-secondary  #A0AEC0
background      #0A0F1F
card surface    #0F1A2E
border          rgba(255,255,255,0.08)
accent          #FF6B2B  (RetentionRail; FilmOps #FFBF47, RENTAHUB #FF6B4A)
primary action  accent bg + #0A0F1F text, 40px, radius 6px
data/focus      #00D4B4  (FilmOps #FF9500, RENTAHUB #00C2A8)
body type       Inter 14px/400
radius default  12px card / 6px control / 9999px pill
gap default     16px
```

Example prompts:
1. "Build a LeadCard per DESIGN.md: 44px avatar in `--brand-secondary`, name at 15px/600, role at 12px `--text-secondary`, status badge from the status map top-right, three score stats at 12px, Enroll (primary sm) + View (secondary sm) actions."
2. "Build the OutreachQueueTable per DESIGN.md: card container, 12px type, `--text-secondary` header row, 1px `rgba(255,255,255,0.06)` row separators, status badges, `--bg-raised` row hover."
3. "Build the Outreach screen shell per DESIGN.md: 64px sticky top bar, 200px `--brand-primary` sidebar with Outreach active, section header, 5-column KPI row, then the queue table."

---

## Quick Start

```css
:root {
  /* surfaces */
  --bg-canvas: #0A0F1F;
  --bg-surface: #0F1A2E;
  --bg-raised: #16233D;
  --scrim: rgba(10, 15, 31, 0.7);

  /* text */
  --text-primary: #FFFFFF;
  --text-secondary: #A0AEC0;
  --text-muted: #6B7B93;

  /* borders */
  --border-default: rgba(255, 255, 255, 0.08);
  --border-strong: rgba(255, 255, 255, 0.12);
  --border-row: rgba(255, 255, 255, 0.06);

  /* semantic */
  --success: #10B981;
  --error: #EF4444;
  --warning: #F59E0B;
  --info: #3B82F6;

  /* venture: RetentionRail (default) */
  --brand-primary: #0F1A2E;
  --brand-secondary: #00D4B4;
  --brand-accent: #FF6B2B;

  /* type */
  --font-sans: 'Inter', system-ui, sans-serif;
  --font-mono: Menlo, monospace;
  --text-display: 32px; --text-h2: 24px; --text-h3: 18px;
  --text-card-title: 15px; --text-body-lg: 16px; --text-body: 14px;
  --text-sm: 13px; --text-caption: 12px; --text-micro: 11px;

  /* spacing */
  --space-0-5: 2px; --space-1: 4px; --space-2: 8px; --space-3: 12px;
  --space-4: 16px; --space-6: 24px; --space-8: 32px; --space-12: 48px;
  --space-16: 64px; --space-24: 96px;

  /* shape */
  --radius-sm: 4px; --radius-md: 6px; --radius-card-sm: 10px;
  --radius-lg: 12px; --radius-xl: 14px; --radius-full: 9999px;

  /* elevation */
  --shadow-1: 0 2px 8px rgba(0,0,0,0.12);
  --shadow-2: 0 4px 12px rgba(0,0,0,0.15);
  --shadow-3: 0 8px 24px rgba(0,0,0,0.18);
  --shadow-4: 0 16px 48px rgba(0,0,0,0.25);
  --focus-ring: 0 0 0 3px rgba(0, 212, 180, 0.13);

  /* layout */
  --page-max: 1440px; --page-pad: 32px;
  --sidebar-w: 200px; --topbar-h: 64px; --subheader-h: 56px; --grid-gap: 16px;
}

[data-venture="filmops"] {
  --brand-primary: #1A1A1A;
  --brand-secondary: #FF9500;
  --brand-accent: #FFBF47;
  --focus-ring: 0 0 0 3px rgba(255, 149, 0, 0.13);
}

[data-venture="rentahub"] {
  --brand-primary: #0F1520;
  --brand-secondary: #00C2A8;
  --brand-accent: #FF6B4A;
  --focus-ring: 0 0 0 3px rgba(0, 194, 168, 0.13);
}
```

**Shipped token mapping** — `app/globals.css` implements this spec under its own pre-existing variable names (`.dark` scope; `:root` is the separate light "Excalix" brand and is out of scope for the operator console):

| This doc | Shipped name | Shipped dark value |
|---|---|---|
| `--brand-accent` (primary action) | `--ink` / `--ink-hover` / `--ink-fg` | `#2DD4BF` / `#5EEAD4` / `#06111F` |
| `--brand-secondary` (data/focus) | `--brand` / `--brand-hover` / `--brand-soft` | `#3B82F6` / `#60A5FA` / `rgba(59,130,246,.16)` |
| Error (destructive only) | `--accent` / `--accent-soft` | `#F0574B` / `rgba(240,87,75,.16)` |
| `--bg-canvas` / `--bg-surface` / `--bg-raised` | *(same names)* | `#0A0F1F` / `#0F1A2E` / `#16233D` |
| `--text-primary/secondary/muted` | *(same names)* | `#F5F7FA` / `#A0AEC0` / `#6B7B93` |
| `--border-default` / `--border-strong` | *(same names)* | `rgba(255,255,255,.08)` / `.14` |
| `--shadow-1/2/3` | *(same names, added)* | tiered dropdown/popover/modal elevation |
| `--space-*`, `--radius-*` | *(same names, added to `.dark`)* | 4px scale; `sm4/md6/card-sm10/lg12/full` |

Component files never hardcode hex — always reach for the shipped variable name via `var(--token)` or a Tailwind class that resolves to one (see `tailwind.config.js`, which remaps `slate`/`indigo` onto these vars).

---

## Notes where brand and good practice conflict

- **FilmOps accent (`#FFBF47`) vs secondary (`#FF9500`)** are both warm yellows and read as the same color at badge size. Recommend keeping accent for actions only and never placing the two adjacent; if FilmOps needs stronger separation, darken secondary to `#E07A00`.
- **RENTAHUB accent `#FF6B4A` on `#0A0F1F`** passes for large text and fills but not for 11–12px body text — use it as a background with `--bg-canvas` text, never as small text.
- `--text-muted` (`#6B7B93`) on canvas is ~4.0:1 — acceptable for timestamps and hex captions, not for anything a user must read to act.

---

## Settings Console IA

An operator-settings surface (providers, models, personas, skills, MCP
connections, cron/scheduled jobs, environment) needs denser information
architecture than the rest of the app: many sibling sections, each fairly
narrow in content, that benefit from a persistent left-rail rather than the
top-level sidebar's flat route list. This section documents the pattern —
adapted from the open-source **adclaw** operator console's grouped sidebar
(Chat / Control / Agent / Settings groups, each with its own icon + item
list) — expressed entirely through this doc's existing tokens and a new
primitive, `SettingsConsole`. No adclaw code, no Ant Design, no second
component library: the pattern is layout/IA only.

**Shell anatomy** — two panes inside one card-level container (`--bg-surface`,
1px `--border-default`, `--radius-lg`):

1. **Left rail** (224px / `w-56`) — `--bg-canvas` (one step darker than the
   content pane, so the rail reads as chrome, not content), grouped nav tree.
   Each group is a collapsible header (11px/600 uppercase `--text-muted`,
   chevron) over a stack of item buttons (13px, 14px icon slot + label).
   Active item: `<ink>15` fill, `--ink` text, 600 weight — the same "accent
   marks the one thing that matters" rule as the top nav, just scoped to
   this rail instead of a leading dot (the rail has no room for a gutter
   dot at this density).
2. **Content pane** — fluid width, optional header row (title 15px/600 +
   description ≤640px + right-aligned actions) over 24px-padded content.

**Suggested groups** (mirrors adclaw's Control/Agent/Settings split, remapped
to this app's operator surface):

```
Agent
  Providers   — connected AI/model providers, keys, health
  Models      — per-provider model catalogue, defaults
  Personas    — persona library (see Skills/Personas.tsx, out of this pass's scope)
  Skills      — skill/tool catalogue available to the agent
  MCP         — connected MCP servers
Operations
  Cron        — scheduled jobs / automations
  Env         — environment variables / secrets
```

Section ids are caller-defined strings; `SettingsConsole` does no routing
itself — callers wire `activeId`/`onSelect` to local state, a query param, or
a route, whichever the page already uses.

**Provider/model cards** (pattern, not a new component in this pass) — reuse
the existing nested-card recipe: `--bg-raised`, `--radius-card-sm` (10px),
16px padding, 15px/600 title + 12px `--text-secondary` meta row, a status
`Badge` top-right (`statusTone`), and at most one `--brand-accent`/`--ink`
action per card. A provider/model *table* (when list density matters more
than card scannability) reuses the existing `DataTable`/table recipe: 12px
type, `--text-secondary` header row, `rgba(255,255,255,.06)` row separators,
`--bg-raised` row hover — do not invent a second table style for settings.

**Agent-console shell** (pattern reference for `AgentConsole.tsx`, out of
this pass's file scope) — adclaw's three-pane pattern (roster left /
conversation center / activity+approvals right) maps onto this app's
existing surfaces as: roster = same rail treatment as the settings left
rail; conversation = `--bg-canvas` content pane with message bubbles as
nested cards; activity/approvals = a third `--bg-surface` column, 280–320px,
using `KPICard`/`Badge`/`EmptyState` for its content. Documented here for
whichever pass next touches `AgentConsole.tsx` — not implemented in this
pass, since that file is out of scope.

**Do** reuse `Button`, `Badge`, `DataTable`, `EmptyState`, `KPICard`,
`Input`/`Dropdown`, `Modal`/`Drawer` inside `SettingsConsole` panes exactly as
elsewhere in the app. **Don't** give the settings console its own button/badge/
input styling — it is the same design system at higher information density,
not a different product surface.
