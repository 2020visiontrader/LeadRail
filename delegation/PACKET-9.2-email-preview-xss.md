# PACKET 9.2 — Sanitize the email template preview

**Tier:** A (live XSS sink on model-generated content) · **Branch:** `feat/copilot-remediation`
**Depends on:** nothing. Independent of every other packet.

---

## The problem

`src/components/EmailPreview.tsx:7`:

```tsx
<div className="prose prose-sm max-w-none p-4"
     dangerouslySetInnerHTML={{ __html: html || '<p …>Nothing to preview</p>' }} />
```

No sanitizer. The `html` prop is injected verbatim into the DOM.

**This is not a theoretical sink.** Its one caller is
`app/outreach/templates/page.tsx:139`, passing `draft.body` — and `draft.body`
is set from the AI refine endpoint at line 68:

```ts
setDraft({ ...draft, subject: template.subject || draft.subject,
                     body: template.body || draft.body });
```

So the HTML rendered here is **model-generated**, from a model whose context
includes third-party data. A prompt-injected or simply malformed generation that
emits `<img src=x onerror=…>` or `<script>` executes in the operator's
authenticated session — the same session that holds CRM data and can trigger
outbound sends.

Packet 9.1 hardened the assistant's markdown path against exactly this class of
input. This is the same class of input on a path 9.1 was not allowed to touch.

Secondary: template bodies are also persisted and sent as real email, so the
stored value has a second consumer. This packet does NOT change what is stored
or sent — only what is rendered in the operator's browser. Say so in the diff.

## Files

**Modify:** `src/components/EmailPreview.tsx`, `package.json` (+ lockfile)

Do not touch `app/outreach/templates/page.tsx`, the templates API, or anything
under `lib/`. If you believe another file must change, STOP and report.

## Approach

Sanitize before injection. Two acceptable routes — pick one and justify it:

1. **`isomorphic-dompurify`** (or `dompurify` with an SSR guard). Sanitize `html`
   with an allowlist, then inject the sanitized string. This is the smaller diff
   and preserves the existing rendering exactly.
2. Render through a sanitizing HTML-to-React parser, avoiding
   `dangerouslySetInnerHTML` entirely.

Route 1 is the recommended default: this is an email preview, so it must keep
rendering real email HTML (tables, inline styles, `<a>`), which a markdown
renderer cannot do. **Do not reuse `src/components/Markdown.tsx` from packet 9.1
here** — email bodies are HTML, not markdown, and that component deliberately
escapes raw HTML.

Whichever you pick, the sanitizer config must:

- **Strip all scripting:** `<script>`, `<iframe>`, `<object>`, `<embed>`, and
  every `on*` event-handler attribute.
- **Constrain URL protocols** on `href`/`src` to `http`, `https`, `mailto`, and
  `cid`. `javascript:`, `data:` and `vbscript:` must not survive. (`data:` URIs
  are common in real email for inline images — if you allow `data:image/*`
  specifically, say so explicitly and justify it; do not allow `data:` broadly.)
- **Keep what email needs:** `table`/`tr`/`td`/`th`, `a`, `img`, `p`, `br`,
  headings, lists, `strong`/`em`, and the `style` attribute. A preview that
  strips layout is a broken feature, not a safe one.
- Run on the client. If the component can render during SSR, guard it so the
  sanitizer does not throw in a Node context.

Match the installed React 18 / Next 14 majors when choosing versions, as packet
9.1 did — pick the version line compatible with those, not merely "latest".

## Verification

1. `./node_modules/.bin/tsc --noEmit`
2. `npm run build`
3. Prove the sanitizer works. Render each of these through the component's
   sanitize step and paste the actual output:
   - `<script>alert(1)</script>`
   - `<img src=x onerror=alert(1)>`
   - `<a href="javascript:alert(1)">x</a>`
   - `<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>`
   - `<iframe src="https://evil.test"></iframe>`
   - `<div onclick="alert(1)">x</div>`
   - A realistic email body with a `<table>`, inline `style`, and an `https` link
     — this one must survive **intact**, proving the fix did not break the feature.

## Acceptance criteria

1. tsc and build pass.
2. No unsanitized value reaches `dangerouslySetInnerHTML` anywhere in
   `src/components/EmailPreview.tsx`.
3. All six hostile inputs above are neutralised; the realistic email renders
   unchanged.
4. Nothing about what is stored or emailed changed — this is a render-path fix.

## Reviewer checklist (human — do not self-certify)

- [ ] The sanitizer runs on EVERY path into the DOM, including the empty-state
      fallback string.
- [ ] Protocol allowlist genuinely excludes `javascript:` and bare `data:`.
- [ ] Email layout (tables, inline styles) still renders — verify visually, not
      just by the test strings.
- [ ] No new dependency pulls in a transitive package with a known advisory
      (`npm install` currently reports 7 pre-existing vulns; do not make it worse,
      and do not run `audit fix` inside this packet).
