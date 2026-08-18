// Shared chrome for the public marketing site: header, nav, footer.
//
// D12: the nav used to be five in-page anchors on one document, so a "tab"
// only scrolled — no shareable URL, nothing separately indexable, and the back
// button did not behave the way a visitor expects. Each entry is now a real
// route. `active` is the pathname of the current page so the nav can mark it
// with aria-current, which is also what tells a crawler these are distinct
// pages rather than five links to the same place.
//
// Server component on purpose — same reason as the page itself: all copy must
// be in the initial HTML for answer engines. Nothing here needs hydration.
import Link from 'next/link';
import { DEMO_MAILTO } from './content';

export const WELCOME_NAV = [
  { href: '/welcome/example-run', label: 'Example run' },
  { href: '/welcome/how-it-works', label: 'How it works' },
  { href: '/welcome/architecture', label: 'Architecture' },
  { href: '/welcome/capabilities', label: 'Capabilities' },
  { href: '/welcome/faq', label: 'FAQ' },
] as const;

export default function WelcomeShell({
  children,
  active,
  jsonLd,
}: {
  children: React.ReactNode;
  /** Pathname of the current page, e.g. '/welcome/faq'. Omitted on the overview. */
  active?: string;
  /** Serialised JSON-LD, rendered only where it belongs (the overview page). */
  jsonLd?: string;
}) {
  return (
    // `marketing` re-binds the design tokens to the warm beige palette defined
    // in globals.css. Scoped here rather than applied globally so the
    // authenticated console keeps its cool slate/navy identity untouched.
    <div className="marketing min-h-screen bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      {jsonLd && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd.replace(/</g, '\\u003c') }} />
      )}

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-[var(--bg-surface)] focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>

      <header className="border-b border-[var(--border-default)] bg-[var(--bg-surface)]">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <Link href="/welcome" className="flex items-center gap-2">
            <span
              aria-hidden
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--ink)] text-[13px] font-bold text-[var(--ink-fg)]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              ↝
            </span>
            <span className="text-[15px] font-bold tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
              LeadRail
            </span>
          </Link>
          <nav aria-label="Sections" className="hidden gap-4 text-[13px] text-[var(--text-secondary)] md:flex">
            {WELCOME_NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active === n.href ? 'page' : undefined}
                className={
                  active === n.href
                    ? 'font-semibold text-[var(--text-primary)]'
                    : 'hover:text-[var(--text-primary)]'
                }
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link
              href="/login"
              className="rounded-md px-3 py-1.5 text-[13px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
            >
              Sign in
            </Link>
            <a
              href={DEMO_MAILTO}
              className="rounded-md bg-[var(--ink)] px-3 py-1.5 text-[13px] font-semibold text-[var(--ink-fg)] transition hover:opacity-90"
            >
              Book a demo
            </a>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        {children}
      </main>

      <footer className="border-t border-[var(--border-default)] bg-[var(--bg-surface)]">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-[13px] text-[var(--text-muted)] sm:px-6">
          <span>© {new Date().getFullYear()} LeadRail — Excalix, Toronto, ON</span>
          <span className="ml-auto flex gap-4">
            <Link href="/privacy" className="hover:text-[var(--text-primary)]">Privacy</Link>
            <Link href="/terms" className="hover:text-[var(--text-primary)]">Terms</Link>
            <Link href="/login" className="hover:text-[var(--text-primary)]">Sign in</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
