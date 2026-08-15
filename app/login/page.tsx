'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function LoginPage() {
  return <Suspense fallback={null}><LoginInner /></Suspense>;
}

// Self-contained dark command-center gate. It owns its own backdrop (slate-950 +
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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#020617] px-4 py-10 text-slate-100">
      {/* Atmosphere: blue core glow + faint grid, command-center feel */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,rgba(37,99,235,0.22),transparent_62%)] blur-2xl" />
        <div className="absolute inset-0 opacity-[0.05]" style={{ backgroundImage: 'linear-gradient(rgba(148,163,184,.7) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.7) 1px,transparent 1px)', backgroundSize: '46px 46px' }} />
      </div>

      <div className="relative w-full max-w-sm animate-fade-in rounded-2xl border border-white/10 bg-slate-900/70 p-8 shadow-[0_24px_64px_rgba(2,6,23,0.6)] backdrop-blur-xl">
        {/* Brand */}
        <div className="mb-7 flex items-center gap-2.5">
          <span
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#2563EB] text-lg text-white shadow-[0_0_20px_rgba(37,99,235,0.55)]"
            style={{ fontFamily: 'var(--font-display)' }}
          >↝</span>
          <span className="text-xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>LeadRail OS</span>
        </div>

        <h1 className="text-lg font-semibold text-white">Operator sign in</h1>
        <p className="mb-6 text-sm text-slate-400">Multi-venture lead command center.</p>

        {expired && !error && (
          <p className="mb-4 flex items-start gap-1.5 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            <span aria-hidden>⏱</span><span>Your session expired — sign in again to pick up where you left off.</span>
          </p>
        )}

        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">Email</span>
            <input
              type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={busy}
              placeholder="you@bdbproductions.com"
              className="w-full rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition focus:border-[#3B82F6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.22)] disabled:opacity-60"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-slate-400">Password</span>
            <input
              type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required disabled={busy}
              placeholder="••••••••"
              className="w-full rounded-lg border border-white/10 bg-slate-950/60 px-3 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition focus:border-[#3B82F6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.22)] disabled:opacity-60"
            />
          </label>

          {error && (
            <p className="flex items-start gap-1.5 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              <span aria-hidden>⚠</span><span>{error}</span>
            </p>
          )}

          <button
            type="submit" disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#2563EB] px-4 py-2.5 text-sm font-semibold text-white shadow-[0_0_24px_rgba(37,99,235,0.35)] transition hover:bg-[#1D4ED8] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {phase === 'verifying' && <Spinner />}
            {phase === 'entering' && <Spinner />}
            {phase === 'idle' ? 'Sign in' : phase === 'verifying' ? 'Verifying…' : 'Entering…'}
          </button>
        </form>

        {/* Honest framing: invite-only, no public signup, no dead end when locked out */}
        <p className="mt-6 border-t border-white/5 pt-5 text-center text-xs leading-relaxed text-slate-500">
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
