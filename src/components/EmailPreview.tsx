'use client';
import { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';

// Renders an email template body as HTML.
//
// SECURITY (packet 9.2): the `html` prop is model-generated. Its caller
// (app/outreach/templates/page.tsx) sets `draft.body` from the AI refine
// endpoint, and that model's context includes third-party data (lead records,
// Notion/Drive documents). It is untrusted input rendered inside the operator's
// authenticated session, so every string that reaches dangerouslySetInnerHTML
// below — including the empty-state fallback — goes through sanitizeEmailHtml
// first.
//
// This is a RENDER-PATH fix only. Nothing here changes what is stored in the
// templates table or what is actually sent as email; the stored value is
// untouched and its other consumers are unaffected.
//
// Why sanitize rather than escape: this is an email preview. Real email bodies
// are HTML — tables, inline styles, links — so packet 9.1's Markdown component
// (which deliberately escapes raw HTML) would turn a working feature into a
// wall of angle brackets. We keep the layout and remove the script.

// Tags an email body legitimately needs. Anything not listed is unwrapped:
// <script>, <iframe>, <object>, <embed>, <form>, <link>, <meta>, <base> and
// friends are all absent from this list, so none of them survive.
const ALLOWED_TAGS = [
  'a', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'col', 'colgroup',
  'dd', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's',
  'small', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
];

// Presentational attributes only. No `on*` handler appears here, and DOMPurify
// additionally strips every on* attribute unconditionally.
const ALLOWED_ATTR = [
  'align', 'alt', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'class',
  'color', 'colspan', 'dir', 'face', 'height', 'href', 'hspace', 'lang',
  'rel', 'role', 'rowspan', 'size', 'span', 'src', 'style', 'target', 'title',
  'valign', 'vspace', 'width',
];

// Protocol allowlist for href/src. Deliberately excludes `javascript:`,
// `vbscript:` and bare `data:`.
//
// `data:` is allowed ONLY for raster image payloads (png/jpeg/gif/webp), which
// are how real email clients inline images — without this, every embedded
// image in a pasted email body breaks. `data:image/svg+xml` is NOT allowed:
// SVG is an active document format and can carry script. `data:text/html`,
// `data:application/*` and every other data payload are likewise excluded.
// installDataUriHook() below narrows this further, to <img src> only.
//
// The trailing `[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$)` alternatives are lifted
// from DOMPurify's own default regexp and are load-bearing: DOMPurify runs
// EVERY attribute value that is not on its internal URI-safe list through this
// pattern, so without them a table's `width="100%"` or `align="left"` is
// discarded along with the hostile URLs. Those alternatives match only values
// that do not begin with a scheme at all (including relative URLs), so
// `javascript:`, `vbscript:` and `data:text/html` still fail every branch.
const ALLOWED_URI_REGEXP =
  /^(?:(?:https?|mailto|cid):|data:image\/(?:png|jpeg|jpg|gif|webp)[;,]|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

const PURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOWED_URI_REGEXP,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  // Belt and braces: these are already absent from ALLOWED_TAGS, but naming
  // them means a future edit to the tag list cannot accidentally reinstate one.
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input',
    'button', 'style', 'link', 'meta', 'base', 'svg', 'math', 'noscript',
    'template', 'portal'],
  // Drop the *contents* of script-bearing elements too, so a stripped
  // <script> tag does not leave its source text visible in the preview.
  // This is DOMPurify's own DEFAULT_FORBID_CONTENTS list (setting the option
  // replaces the default rather than extending it, so it is restated in full)
  // plus <object> and <embed>.
  FORBID_CONTENTS: ['annotation-xml', 'audio', 'colgroup', 'desc', 'embed',
    'foreignobject', 'head', 'iframe', 'math', 'mi', 'mn', 'mo', 'ms', 'mtext',
    'noembed', 'noframes', 'noscript', 'object', 'plaintext', 'script', 'style',
    'svg', 'template', 'thead', 'title', 'video', 'xmp'],
  KEEP_CONTENT: true,
  RETURN_DOM: false as const,
  RETURN_DOM_FRAGMENT: false as const,
  // Whole-document constructs are never wanted in a body preview.
  WHOLE_DOCUMENT: false,
};

const EMPTY_STATE = '<p class="text-slate-400">Nothing to preview</p>';

// Only inline raster images may use a `data:` URI, and only as an <img src>.
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp)[;,]/i;

// DOMPurify has an internal DATA_URI_TAGS carve-out that lets ANY `data:`
// payload through on `src` for <img>, regardless of ALLOWED_URI_REGEXP, and the
// regexp on its own cannot tell `<img src>` from `<a href>`. There is no config
// switch for either, so this hook enforces the narrower policy described above:
// `data:` survives on <img src> for the four raster types and nowhere else —
// notably not `data:image/svg+xml`, since SVG is an active document format.
let hookInstalled = false;
function installDataUriHook() {
  if (hookInstalled) return;
  hookInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    // nodeType 1 === element; checked this way rather than `instanceof Element`
    // so the hook does not depend on a same-realm global.
    if (node.nodeType !== 1) return;
    const el = node as Element;
    for (const attr of ['src', 'href'] as const) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      // Strip the same whitespace/control characters DOMPurify removes before
      // its own protocol test, so `data:\n\ttext/html...` cannot slip past.
      const normalized = value.replace(/[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]+/g, '');
      if (!/^data:/i.test(normalized)) continue;
      const isInlineImage = el.tagName.toLowerCase() === 'img'
        && attr === 'src'
        && SAFE_DATA_IMAGE.test(normalized);
      if (!isInlineImage) el.removeAttribute(attr);
    }
  });
}

/**
 * Sanitize an email body for display. Browser-only: DOMPurify needs a real DOM,
 * and in a Node/SSR context `DOMPurify.isSupported` is false and `sanitize()`
 * would hand the input straight back unchanged. Rather than rely on that, we
 * return '' on the server and let the effect below fill the preview in on the
 * client — so an unsanitized string can never reach the DOM by either route.
 */
export function sanitizeEmailHtml(html: string): string {
  if (typeof window === 'undefined' || !DOMPurify.isSupported) return '';
  installDataUriHook();
  return DOMPurify.sanitize(html || EMPTY_STATE, PURIFY_CONFIG);
}

export default function EmailPreview({ subject, html }: { subject: string; html: string }) {
  // `mounted` keeps the server-rendered markup (empty body) and the first
  // client render identical, avoiding a hydration mismatch; the sanitized HTML
  // lands on the pass right after.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const safeHtml = useMemo(() => (mounted ? sanitizeEmailHtml(html) : ''), [mounted, html]);

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-700">
        Subject: {subject || '(no subject)'}
      </div>
      <div className="prose prose-sm max-w-none p-4" dangerouslySetInnerHTML={{ __html: safeHtml }} />
    </div>
  );
}
