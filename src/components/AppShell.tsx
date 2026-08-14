'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/assistant', label: 'Assistant' },
  { href: '/leads', label: 'Leads' },
  { href: '/enrichment', label: 'Enrichment' },
  { href: '/sequences', label: 'Sequences' },
  { href: '/journeys', label: 'Journeys' },
  { href: '/templates', label: 'Templates' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/outreach', label: 'Outreach' },
  { href: '/content', label: 'Content' },
  { href: '/pipeline', label: 'AI Pipeline' },
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/companies', label: 'Companies' },
  { href: '/deals', label: 'Pipeline' },
  { href: '/activities', label: 'Activities' },
  { href: '/referrals', label: 'Ambassador' },
  { href: '/settings', label: 'Settings' },
];

// Platform-admin (owner) only — never shown to client accounts.
const OWNER_NAV = [{ href: '/admin', label: 'Admin' }, { href: '/logs', label: 'Logs' }];

function AccountFooter() {
  const [email, setEmail] = useState<string>('');
  useEffect(() => { fetch('/api/auth/me', { headers: { Accept: 'application/json' } }).then((r) => r.ok ? r.json() : null).then((d) => d?.email && setEmail(d.email)).catch(() => {}); }, []);
  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', headers: { Accept: 'application/json' } }).catch(() => {});
    window.location.href = '/login';
  };
  return (
    <div className="px-1">
      <div className="truncate px-2.5 pb-1 text-[11px] text-[var(--text-muted)]">{email || 'Admin'} · LeadRail</div>
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

function Wordmark() {
  return (
    <div className="flex items-center gap-2 px-1">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--ink)] text-[13px] font-bold text-[var(--ink-fg)]" style={{ fontFamily: 'var(--font-display)' }}>↝</span>
      <span className="text-[15px] font-bold tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>LeadRail</span>
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [isOwner, setIsOwner] = useState(false);
  useEffect(() => {
    fetch('/api/auth/me', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setIsOwner(d?.role === 'owner'))
      .catch(() => {});
  }, []);
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const bareRoutes = ['/login', '/privacy', '/terms', '/data-deletion'];
  if (bareRoutes.some((r) => pathname === r)) return <>{children}</>;
  // Owner sees platform-admin items (Logs) appended; client accounts never do.
  const nav = isOwner ? [...NAV, ...OWNER_NAV] : NAV;
  return (
    <div className="flex min-h-screen bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      <aside className="hidden w-52 shrink-0 flex-col border-r border-[var(--border-default)] bg-[var(--bg-surface)] md:flex">
        <div className="flex h-16 shrink-0 items-center px-4">
          <Wordmark />
        </div>
        <nav className="console-rail-scroll flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
          {nav.map((n) => {
            const active = isActive(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px] transition ${
                  active ? 'font-semibold text-[var(--ink)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]'
                }`}
                style={active ? { background: 'color-mix(in srgb, var(--ink) 15%, transparent)' } : undefined}
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full transition-colors ${active ? 'bg-[var(--ink)]' : 'bg-transparent'}`} />
                <span className="truncate">{n.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="space-y-1 border-t border-[var(--border-default)] px-2 py-3">
          <ThemeToggle />
          <AccountFooter />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-4 overflow-x-auto border-b border-[var(--border-default)] bg-[var(--bg-surface)] px-4 md:hidden">
          <Wordmark />
          {nav.map((n) => (
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
