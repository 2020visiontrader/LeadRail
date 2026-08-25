'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import NotificationsBell from '@/components/NotificationsBell';
import {
  IconDashboard, IconAssistant, IconLeads, IconEnrichment, IconCompanies, IconDeals,
  IconSegments, IconActivities, IconInbox, IconOutreach, IconSequences, IconJourneys,
  IconTemplates, IconForms, IconContent, IconPipeline, IconCampaigns, IconAnalytics,
  IconAmbassador, IconSettings, IconAdmin, IconLogs,
} from '@/components/icons';

// GROUPED NAVIGATION.
//
// Twenty items in one flat column is a list, not a navigation. Nothing tells
// you that Sequences and Templates are the same job, or that Enrichment is
// something you do TO leads — so finding anything meant reading all twenty
// labels every time. The groups below are the five jobs the platform actually
// does, and each is the answer to "what am I here to do right now".
//
// The order is the order of the work: you look at the state of things, you
// build the list, you reach out, you make the material, you read the result.
//
// Settings/Admin/Logs live OUTSIDE the groups, pinned to the bottom rail —
// they are not a job, they are where you go to change how the jobs behave.
interface NavItem { href: string; label: string; icon: (p: { size?: number }) => JSX.Element }
interface NavGroup { id: string; label: string; items: NavItem[] }

const NAV_GROUPS: NavGroup[] = [
  {
    id: 'work',
    label: 'Work',
    items: [
      { href: '/', label: 'Dashboard', icon: IconDashboard },
      { href: '/activities', label: 'Activities', icon: IconActivities },
    ],
  },
  {
    id: 'pipeline',
    label: 'Pipeline',
    items: [
      { href: '/leads', label: 'Leads', icon: IconLeads },
      { href: '/enrichment', label: 'Enrichment', icon: IconEnrichment },
      { href: '/segments', label: 'Segments', icon: IconSegments },
      { href: '/companies', label: 'Companies', icon: IconCompanies },
      { href: '/deals', label: 'Deals', icon: IconDeals },
    ],
  },
  {
    id: 'outreach',
    label: 'Outreach',
    items: [
      { href: '/inbox', label: 'Inbox', icon: IconInbox },
      { href: '/outreach', label: 'Send', icon: IconOutreach },
      { href: '/sequences', label: 'Sequences', icon: IconSequences },
      { href: '/journeys', label: 'Journeys', icon: IconJourneys },
      { href: '/templates', label: 'Templates', icon: IconTemplates },
      { href: '/forms', label: 'Forms', icon: IconForms },
    ],
  },
  {
    id: 'content',
    label: 'Content',
    items: [
      { href: '/content', label: 'Content', icon: IconContent },
      { href: '/pipeline', label: 'Engine', icon: IconPipeline },
      { href: '/campaigns', label: 'Campaigns', icon: IconCampaigns },
    ],
  },
  {
    id: 'insight',
    label: 'Insight',
    items: [
      { href: '/analytics', label: 'Analytics', icon: IconAnalytics },
      { href: '/referrals', label: 'Ambassador', icon: IconAmbassador },
    ],
  },
];

// Pinned below the groups. Settings is for everyone; the other two are
// platform-admin and never rendered for a client account.
const UTILITY_NAV: NavItem[] = [{ href: '/settings', label: 'Settings', icon: IconSettings }];
const OWNER_NAV: NavItem[] = [
  { href: '/admin', label: 'Admin', icon: IconAdmin },
  { href: '/logs', label: 'Logs', icon: IconLogs },
];

// Flat list of every reachable item — the mobile header and any lookup that
// does not care about grouping reads this, so a new item never has to be
// added in two places.
const ALL_ITEMS = (isOwner: boolean): NavItem[] => [
  ...NAV_GROUPS.flatMap((g) => g.items),
  ...UTILITY_NAV,
  ...(isOwner ? OWNER_NAV : []),
];

// Every account polls its own running build against the server's — same idea as
// Zo's own "update available" indicator. No deploy trigger lives here; a deploy
// already happened server-side, this just tells an open tab its JS is stale and
// lets the user pick up the new build with one click.
const VERSION_POLL_MS = 5 * 60 * 1000;

/** Per-browser memory of which nav groups are folded shut. */
const RAIL_COLLAPSE_KEY = 'leadrail.rail.collapsed';

function useVersionCheck() {
  const [loadedSha, setLoadedSha] = useState<string | null>(null);
  const [latestSha, setLatestSha] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetch('/api/version', { headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled || !d?.sha) return;
          setLatestSha(d.sha);
          setLoadedSha((prev) => prev ?? d.sha);
        })
        .catch(() => {});
    };
    check();
    const id = setInterval(check, VERSION_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
  return { updateAvailable: Boolean(loadedSha && latestSha && loadedSha !== latestSha), latestSha };
}

function AccountFooter() {
  const [email, setEmail] = useState<string>('');
  useEffect(() => { fetch('/api/auth/me', { headers: { Accept: 'application/json' } }).then((r) => r.ok ? r.json() : null).then((d) => d?.email && setEmail(d.email)).catch(() => {}); }, []);
  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', headers: { Accept: 'application/json' } }).catch(() => {});
    window.location.href = '/login';
  };
  const { updateAvailable, latestSha } = useVersionCheck();
  return (
    <div className="px-1">
      <div className="truncate px-2.5 pb-1 text-[11px] text-[var(--text-muted)]">{email || 'Admin'} · LeadRail</div>
      {updateAvailable && (
        <button
          onClick={() => window.location.reload()}
          title={latestSha ? `Load build ${latestSha}` : undefined}
          className="mb-1 flex w-full items-center gap-2 rounded-md bg-[var(--status-active)]/10 px-2.5 py-2 text-[13px] font-medium text-[var(--status-active)] transition hover:bg-[var(--status-active)]/20"
        >
          <span aria-hidden className="text-[13px] leading-none">↻</span>Update available
        </button>
      )}
      {/* The public site was reachable only by signing out, which is a strange
          price to pay for reading your own marketing page. /welcome is already
          public, so a signed-in user can open it and come straight back. */}
      <Link href="/welcome" className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]">
        <span aria-hidden className="text-[13px] leading-none">◹</span>Landing page
      </Link>
      <button onClick={logout} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]">
        <span aria-hidden className="text-[13px] leading-none">⇥</span>Sign out
      </button>
    </div>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => { setDark(document.documentElement.classList.contains('dark')); }, []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem('theme', next ? 'dark' : 'light'); } catch {}
  };
  return (
    <button onClick={toggle} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]">
      <span aria-hidden className="text-[13px] leading-none">{dark ? '☾' : '☀'}</span>{dark ? 'Dark' : 'Light'} mode
    </button>
  );
}

/** The logo, as a link home.
 *
 *  It was a plain div, so clicking it did nothing — and clicking the logo is
 *  the single most reflexive navigation there is. Points at the dashboard,
 *  which is what a logo means inside a signed-in app; the public landing page
 *  is reachable from the account menu below. */
function Wordmark() {
  return (
    <Link
      href="/"
      aria-label="LeadRail home"
      className="flex items-center gap-2 rounded-md px-1 py-0.5 transition hover:opacity-80"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--ink)] text-[13px] font-bold text-[var(--ink-fg)]" style={{ fontFamily: 'var(--font-display)' }}>↝</span>
      <span className="text-[15px] font-bold tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>LeadRail</span>
    </Link>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [isOwner, setIsOwner] = useState(false);
  // Which groups are folded shut. Persisted per browser: someone who never
  // touches Campaigns should not have to close that group on every visit.
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RAIL_COLLAPSE_KEY);
      if (raw) setCollapsedGroups(JSON.parse(raw));
    } catch { /* private mode, or blocked site data — open groups is a fine default */ }
  }, []);
  const toggleGroup = (id: string) => {
    setCollapsedGroups((prev) => {
      const next = prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id];
      try { window.localStorage.setItem(RAIL_COLLAPSE_KEY, JSON.stringify(next)); } catch { /* see above */ }
      return next;
    });
  };
  useEffect(() => {
    fetch('/api/auth/me', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setIsOwner(d?.role === 'owner'))
      .catch(() => {});
  }, []);
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const onAssistantPage = pathname === '/assistant';
  // '/welcome' (Packet 11.2) joins the existing bare routes: it is the public
  // landing page and brings its own <header>/<main>/<footer>, so wrapping it in
  // the authenticated nav rail would show a logged-out visitor a dashboard
  // sidebar and nest a second <main>.
  // D12: '/welcome' now has sub-pages (/welcome/how-it-works, /faq, …), so an
  // EXACT match would leave those wrapped in the authenticated shell — the very
  // bug this list exists to prevent, just one path segment deeper. Match on a
  // path-segment boundary instead, the same rule middleware.ts uses for its
  // public prefixes, so every current and future marketing page stays bare.
  const bareRoutes = ['/login', '/privacy', '/terms', '/data-deletion', '/welcome'];
  if (bareRoutes.some((r) => pathname === r || pathname.startsWith(`${r}/`))) return <>{children}</>;
  // Owner sees platform-admin items appended; client accounts never do.
  const utilityItems: NavItem[] = [...UTILITY_NAV, ...(isOwner ? OWNER_NAV : [])];
  const flatNav = ALL_ITEMS(isOwner);
  return (
    <div className="flex min-h-screen bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      {/* h-screen + sticky, not auto height. As a flex sibling with no height
          constraint the rail grew to fit its ~22 nav items (1107px) and, being
          the tallest child, stretched the whole row — so EVERY page inherited
          1107px of document height against a 722px viewport and picked up ~385px
          of dead scroll it had no content for. The inner <nav> already scrolls
          (console-rail-scroll), so pinning the rail to the viewport costs
          nothing and lets each page own its own height. */}
      <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col border-r border-[var(--border-default)] bg-[var(--bg-surface)] md:flex">
        <div className="flex h-16 shrink-0 items-center px-4">
          <Wordmark />
        </div>
        <div className="px-3 pb-1">
          {/* ONE Assistant, not two.
              There used to be a dock toggle here AND an "Assistant" item in the
              WORK group below, pointing at two different surfaces: the dock had
              no multi-chat tabs, so the two looked like the same feature working
              differently, which is worse than an obviously missing one. This is
              now the single entry, and it opens the full page. */}
          <Link
            href="/assistant"
            aria-current={onAssistantPage ? 'page' : undefined}
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[13px] transition ${
              onAssistantPage ? 'bg-[var(--ink)] font-semibold text-[var(--ink-fg)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]'
            }`}
            style={!onAssistantPage ? { background: 'color-mix(in srgb, var(--ink) 12%, transparent)' } : undefined}
          >
            <span aria-hidden className="text-[13px] leading-none">✦</span>
            <span className="truncate">Assistant</span>
            <kbd className="ml-auto rounded border border-[var(--border-default)] px-1 text-[11px] text-[var(--text-muted)]">⌘J</kbd>
          </Link>
        </div>
        <nav className="console-rail-scroll flex-1 overflow-y-auto px-3 py-2">
          {NAV_GROUPS.map((group) => {
            const collapsed = collapsedGroups.includes(group.id);
            // A collapsed group still shows a dot when the current page is
            // inside it — otherwise closing a group hides where you are.
            const holdsActive = group.items.some((i) => isActive(i.href));
            return (
              <div key={group.id} className="mb-1">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.id)}
                  aria-expanded={!collapsed}
                  className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)] transition hover:text-[var(--text-secondary)]"
                >
                  <svg
                    width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden
                    className={`shrink-0 transition-transform duration-150 ${collapsed ? '-rotate-90' : ''}`}
                  >
                    <path d="M1.5 2.75 4 5.25l2.5-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="truncate">{group.label}</span>
                  {collapsed && holdsActive && (
                    <span aria-hidden className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ink)]" />
                  )}
                </button>
                {!collapsed && (
                  <div className="space-y-0.5">
                    {group.items.map((n) => {
                      const active = isActive(n.href);
                      const Icon = n.icon;
                      return (
                        <Link
                          key={n.href}
                          href={n.href}
                          aria-current={active ? 'page' : undefined}
                          className={`flex items-center gap-2.5 rounded-md py-2 pl-3 pr-2.5 text-[13px] transition ${
                            active
                              ? 'font-semibold text-[var(--ink)]'
                              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]'
                          }`}
                          style={active ? { background: 'color-mix(in srgb, var(--ink) 15%, transparent)' } : undefined}
                        >
                          <Icon size={15} />
                          <span className="truncate">{n.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          <div className="my-2 border-t border-[var(--border-default)]" />

          <div className="space-y-0.5">
            {utilityItems.map((n) => {
              const active = isActive(n.href);
              const Icon = n.icon;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition ${
                    active
                      ? 'font-semibold text-[var(--ink)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]'
                  }`}
                  style={active ? { background: 'color-mix(in srgb, var(--ink) 15%, transparent)' } : undefined}
                >
                  <Icon size={15} />
                  <span className="truncate">{n.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>
        <div className="space-y-1 border-t border-[var(--border-default)] px-2 py-3">
          <div className="px-1 pb-1"><NotificationsBell /></div>
          <ThemeToggle />
          <AccountFooter />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-4 overflow-x-auto border-b border-[var(--border-default)] bg-[var(--bg-surface)] px-4 md:hidden">
          <Wordmark />
          {flatNav.map((n) => (
            <Link key={n.href} href={n.href} className={`whitespace-nowrap text-[13px] ${isActive(n.href) ? 'font-semibold text-[var(--ink)]' : 'text-[var(--text-secondary)]'}`}>
              {n.label}
            </Link>
          ))}
        </header>
        <main className="mx-auto w-full max-w-[1440px] flex-1 p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
