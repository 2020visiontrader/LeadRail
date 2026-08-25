'use client';
import { Suspense, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function SignupPage() {
  return <Suspense fallback={null}><SignupInner /></Suspense>;
}

// Public registration. Deliberately mirrors app/login/page.tsx — same backdrop,
// same card, same field styling — because these two pages are the only pre-auth
// surfaces and a visitor moves between them. Divergence here reads as a phishing
// page, not as variety.
//
// NEXT_PUBLIC_SIGNUPS_OPEN mirrors the server's SIGNUPS_OPEN. The server is the
// authority and will refuse regardless; this only decides whether we show a form
// that would fail. A closed signup is not an error state — it routes the visitor
// to request access, which is a working front door.
const OPEN = process.env.NEXT_PUBLIC_SIGNUPS_OPEN === '1';

function SignupInner() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<'idle' | 'creating' | 'entering'>('idle');
  const busy = phase !== 'idle';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPhase('creating'); setError('');
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, password, company }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Could not create the account.');
      setPhase('entering');
      router.replace('/');
      router.refresh();
    } catch (err: any) {
      setError(err.message || 'Could not create the account.');
      setPhase('idle');
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[var(--bg-canvas)] px-4 py-10 text-[var(--text-primary)]">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle,var(--brand-soft),transparent_62%)] blur-2xl" />
        <div className="absolute inset-0 opacity-[0.05]" style={{ backgroundImage: 'linear-gradient(var(--border-strong) 1px,transparent 1px),linear-gradient(90deg,var(--border-strong) 1px,transparent 1px)', backgroundSize: '46px 46px' }} />
      </div>

      <div className="relative w-full max-w-sm animate-fade-in rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-8 shadow-[var(--shadow-pop)] backdrop-blur-xl">
        <div className="mb-7 flex items-center gap-2.5">
          <span
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--ink)] text-lg text-[var(--ink-fg)]"
            style={{ fontFamily: 'var(--font-display)' }}
          >↝</span>
          <span className="text-xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>LeadRail OS</span>
        </div>

        {!OPEN ? (
          <>
            <h1 className="text-lg font-semibold">Request access</h1>
            <p className="mb-6 text-sm text-[var(--text-secondary)]">
              We are onboarding teams one at a time so every workspace gets set up properly.
            </p>
            <Link
              href="/welcome#contact"
              className="flex w-full items-center justify-center rounded-lg bg-[var(--ink)] px-4 py-2.5 text-sm font-semibold text-[var(--ink-fg)] transition hover:bg-[var(--ink-hover)]"
            >
              Request access
            </Link>
            <p className="mt-6 border-t border-[var(--border-default)] pt-5 text-center text-xs leading-relaxed text-[var(--text-muted)]">
              Already have an account? <Link href="/login" className="font-medium text-[var(--text-secondary)] underline">Sign in</Link>
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold">Create your workspace</h1>
            <p className="mb-6 text-sm text-[var(--text-secondary)]">Start free. No card required.</p>

            <form onSubmit={submit} className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">Work email</span>
                <input
                  type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={busy}
                  placeholder="you@company.com"
                  className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition focus:border-[var(--brand)] focus:shadow-[var(--focus-ring)] disabled:opacity-60"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">Company <span className="normal-case text-[var(--text-muted)]">(optional)</span></span>
                <input
                  type="text" autoComplete="organization" value={company} onChange={(e) => setCompany(e.target.value)} disabled={busy}
                  placeholder="Acme Studio"
                  className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition focus:border-[var(--brand)] focus:shadow-[var(--focus-ring)] disabled:opacity-60"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">Password</span>
                <input
                  type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required disabled={busy}
                  placeholder="At least 10 characters"
                  className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition focus:border-[var(--brand)] focus:shadow-[var(--focus-ring)] disabled:opacity-60"
                />
              </label>

              {error && (
                <p className="flex items-start gap-1.5 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-700">
                  <span aria-hidden>⚠</span><span>{error}</span>
                </p>
              )}

              <button
                type="submit" disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--ink)] px-4 py-2.5 text-sm font-semibold text-[var(--ink-fg)] transition hover:bg-[var(--ink-hover)] disabled:cursor-not-allowed disabled:opacity-70"
              >
                {busy && <Spinner />}
                {phase === 'idle' ? 'Create workspace' : phase === 'creating' ? 'Creating…' : 'Entering…'}
              </button>
            </form>

            <p className="mt-6 border-t border-[var(--border-default)] pt-5 text-center text-xs leading-relaxed text-[var(--text-muted)]">
              Already have an account? <Link href="/login" className="font-medium text-[var(--text-secondary)] underline">Sign in</Link>
            </p>
          </>
        )}
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
