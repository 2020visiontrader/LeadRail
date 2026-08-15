'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import LoadingSpinner from '@/components/LoadingSpinner';
import PlatformBackend from '@/components/PlatformBackend';
import ActivityFeed from '@/components/ActivityFeed';

// Owner Admin portal — the one place platform-ops surfaces live: infra/service
// keys (Platform backend), the live request feed (Live activity), and a link
// into the full filterable Logs page. Client accounts never reach this route;
// on a non-owner it renders the same "owners only" notice the Logs page uses.
export default function AdminPage() {
  const [isOwner, setIsOwner] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/auth/me', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setIsOwner(d?.role === 'owner'))
      .catch(() => setIsOwner(false));
  }, []);

  if (isOwner === null) return <LoadingSpinner />;

  if (!isOwner) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-bold text-slate-900">Admin</h1>
        <p className="mt-4 text-sm text-slate-500">This page is available to account owners and admins only.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Admin</h1>
        <p className="text-sm text-slate-500">Platform operations — infrastructure, service keys, and the live system feed. Owner only.</p>
      </div>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-8">
          <PlatformBackend />
        </div>
        <div className="space-y-4 xl:sticky xl:top-6 xl:self-start">
          <div className="h-[520px]">
            <ActivityFeed />
          </div>
          <Link
            href="/logs"
            className="flex items-center justify-between rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] px-4 py-3 text-sm transition hover:bg-[var(--bg-raised)]"
          >
            <span>
              <span className="block font-semibold text-[var(--text-primary)]">Full logs</span>
              <span className="block text-xs text-[var(--text-muted)]">Every API action — filter by level, search, latency.</span>
            </span>
            <span aria-hidden className="text-[var(--text-muted)]">→</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
