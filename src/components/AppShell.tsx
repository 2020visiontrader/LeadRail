'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/leads', label: 'Leads' },
  { href: '/enrichment', label: 'Enrichment' },
  { href: '/sequences', label: 'Sequences' },
  { href: '/templates', label: 'Templates' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/outreach', label: 'Outreach' },
  { href: '/content', label: 'Content' },
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/companies', label: 'Companies' },
  { href: '/deals', label: 'Pipeline' },
  { href: '/activities', label: 'Activities' },
  { href: '/settings', label: 'Settings' },
];

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
    <button onClick={toggle} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-[var(--text-secondary)] transition hover:bg-[var(--bg-raised)]">
      <span aria-hidden>{dark ? '☾' : '☀'}</span>{dark ? 'Dark' : 'Light'} mode
    </button>
  );
}

function Wordmark() {
  return (
    <div className="flex items-center gap-2 px-2">
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--ink)] text-[13px] text-[var(--ink-fg)]" style={{ fontFamily: 'var(--font-display)' }}>↝</span>
      <span className="text-lg font-bold" style={{ fontFamily: 'var(--font-display)' }}>LeadRail</span>
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  return (
    <div className="flex min-h-screen bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-[var(--border-default)] bg-[var(--bg-surface)] md:flex">
        <div className="px-4 py-5"><Wordmark /></div>
        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.map((n) => {
            const active = isActive(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition ${
                  active ? 'bg-[var(--bg-raised)] font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-raised)]'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-[var(--brand)]' : 'bg-transparent'}`} />
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-[var(--border-default)] px-3 py-3">
          <ThemeToggle />
          <div className="px-3 pt-2 text-[11px] text-[var(--text-muted)]">Admin · BDB Productions</div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-4 overflow-x-auto border-b border-[var(--border-default)] bg-[var(--bg-surface)] px-4 py-3 md:hidden">
          <Wordmark />
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={`whitespace-nowrap text-sm ${isActive(n.href) ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
              {n.label}
            </Link>
          ))}
        </header>
        <main className="mx-auto w-full max-w-[1440px] flex-1 p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
