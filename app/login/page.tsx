'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function LoginPage() {
  return <Suspense fallback={null}><LoginInner /></Suspense>;
}

// Self-contained sign-in gate. It owns its own backdrop (canvas token +
// blue glow) so it looks identical regardless of the in-app light/dark toggle —
// this is the pre-auth surface and the first impression of the console.
function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  // phase: idle → verifying → entering (success, redirecting)
  const [phase, setPhase] = useState<'idle' | 'verifying' | 'entering'>('idle');
  const busy = phase !== 'idle';
  // Set when an authed API 401'd mid-session and bounced the operator here.
  const expired = params.get('expired') === '1';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPhase('verifying'); setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Login failed');
      // Success — hold on an "Entering" state so the redirect isn't a blank flash.
      setPhase('entering');
      router.replace(params.get('next') || '/');
      router.refresh();
    } catch (err: any) {
      setError(err.message || 'Login failed');
      setPhase('idle');
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[var(--bg-canvas)] px-4 py-10 text-[var(--text-primary)]">
      {/* Atmosphere: a warm core glow + faint grid. Tokenised — this page used to
          hardcode #020617/#2563EB/slate-*, which is why the palette change did not
          reach it and it stayed blue after everything else went warm. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,var(--brand-soft),transparent_62%)] blur-2xl" />
        <div className="absolute inset-0 opacity-[0.05]" style={{ backgroundImage: 'linear-gradient(var(--border-strong) 1px,transparent 1px),linear-gradient(90deg,var(--border-strong) 1px,transparent 1px)', backgroundSize: '46px 46px' }} />
      </div>

      <div className="relative w-full max-w-sm animate-fade-in rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-8 shadow-[var(--shadow-pop)] backdrop-blur-xl">
        {/* Brand */}
        <div className="mb-7 flex items-center gap-2.5">
          <span
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--ink)] text-lg text-[var(--ink-fg)]"
            style={{ fontFamily: 'var(--font-display)' }}
          >↝</span>
          <span className="text-xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>LeadRail OS</span>
        </div>

        <h1 className="text-lg font-semibold text-[var(--text-primary)]">Operator sign in</h1>
        <p className="mb-6 text-sm text-[var(--text-secondary)]">Multi-brand lead command center.</p>

        {expired && !error && (
          <p className="mb-4 flex items-start gap-1.5 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            <span aria-hidden>⏱</span><span>Your session expired — sign in again to pick up where you left off.</span>
          </p>
        )}

        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">Email</span>
            <input
              type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={busy}
              placeholder="you@bdbproductions.com"
              className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition focus:border-[var(--brand)] focus:shadow-[var(--focus-ring)] disabled:opacity-60"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">Password</span>
            <input
              type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required disabled={busy}
              placeholder="••••••••"
              className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition focus:border-[var(--brand)] focus:shadow-[var(--focus-ring)] disabled:opacity-60"
            />
          </label>

          {error && (
            <p className="flex items-start gap-1.5 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              <span aria-hidden>⚠</span><span>{error}</span>
            </p>
          )}

          <button
            type="submit" disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--ink)] px-4 py-2.5 text-sm font-semibold text-[var(--ink-fg)] transition hover:bg-[var(--ink-hover)] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {phase === 'verifying' && <Spinner />}
            {phase === 'entering' && <Spinner />}
            {phase === 'idle' ? 'Sign in' : phase === 'verifying' ? 'Verifying…' : 'Entering…'}
          </button>
        </form>

        {/* Honest framing: invite-only, no public signup, no dead end when locked out */}
        <p className="mt-6 border-t border-[var(--border-default)] pt-5 text-center text-xs leading-relaxed text-[var(--text-muted)]">
          Invite-only operator console — there's no public signup.<br />
          Locked out? Ask your workspace admin to reset your access.
        </p>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}
