'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV = [
  { href: '/', label: 'Overview', icon: '📊' },
  { href: '/leads', label: 'Leads', icon: '📋' },
  { href: '/companies', label: 'Companies', icon: '🏢' },
  { href: '/deals', label: 'Pipeline', icon: '💰' },
  { href: '/activities', label: 'Activities', icon: '✅' },
  { href: '/outreach', label: 'Outreach', icon: '📧' },
  { href: '/content', label: 'Content', icon: '📱' },
  { href: '/campaigns', label: 'Campaigns', icon: '🎯' },
  { href: '/settings', label: 'Settings', icon: '⚙️' },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="px-5 py-5">
          <div className="text-lg font-bold">Agency OS</div>
          <div className="text-xs text-slate-400">Rentahub</div>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                isActive(n.href) ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <span>{n.icon}</span>{n.label}
            </Link>
          ))}
        </nav>
        <div className="px-5 py-4 text-xs text-slate-400">Marketing Agency OS</div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 overflow-x-auto border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={`whitespace-nowrap text-sm ${isActive(n.href) ? 'font-semibold text-indigo-700' : 'text-slate-500'}`}>
              {n.label}
            </Link>
          ))}
        </header>
        <main className="flex-1 p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
