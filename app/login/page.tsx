'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function LoginPage() {
  return <Suspense fallback={null}><LoginInner /></Suspense>;
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Login failed');
      router.replace(params.get('next') || '/');
      router.refresh();
    } catch (err: any) { setError(err.message || 'Login failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-canvas)] px-4">
      <div className="w-full max-w-sm rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-8 shadow-[var(--shadow-pop)]">
        <div className="mb-6 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--ink)] text-[var(--ink-fg)]" style={{ fontFamily: 'var(--font-display)' }}>↝</span>
          <span className="text-xl font-bold" style={{ fontFamily: 'var(--font-display)' }}>LeadRail</span>
        </div>
        <h1 className="text-lg font-semibold">Sign in</h1>
        <p className="mb-5 text-sm text-[var(--text-secondary)]">Admin access — BDB Productions.</p>
        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">Email</span>
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required
              className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--brand)] focus:shadow-[var(--focus-ring)]" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--text-secondary)]">Password</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required
              className="w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--brand)] focus:shadow-[var(--focus-ring)]" />
          </label>
          {error && <p className="text-sm text-[var(--status-negative)]">{error}</p>}
          <button type="submit" disabled={busy}
            className="w-full rounded-md bg-[var(--ink)] px-4 py-2 text-sm font-medium text-[var(--ink-fg)] transition hover:bg-[var(--ink-hover)] disabled:opacity-50">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
