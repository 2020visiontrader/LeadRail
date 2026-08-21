'use client';
import { useState } from 'react';

// The marketing site's contact channel.
//
// Replaces `mailto:` links pointing at a personal Gmail address. A mailto is
// not a contact channel: it publishes a private inbox, it does nothing at all
// for anyone browsing without a configured mail client (most people, on most
// phones), and it leaves no record that a request was ever made. Every one of
// those failures is silent — the visitor thinks they got in touch.

type Intent = 'demo request' | 'access request' | 'general';

export function ContactForm({ intent = 'general', heading, blurb }: {
  intent?: Intent; heading?: string; blurb?: string;
}) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', email: '', company: '', message: '', website: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState('sending'); setError('');
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...form, intent }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Could not send that just now.');
      setState('sent');
    } catch (err: any) {
      setError(err.message || 'Could not send that just now.');
      setState('idle');
    }
  };

  if (state === 'sent') {
    return (
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-raised)] p-6 text-center">
        <p className="text-base font-semibold text-[var(--text-primary)]">Thanks — that reached us.</p>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          We reply to everything within one business day, to {form.email}.
        </p>
      </div>
    );
  }

  const field = 'w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition focus:border-[var(--brand)] focus:shadow-[var(--focus-ring)] disabled:opacity-60';
  const busy = state === 'sending';

  return (
    <form onSubmit={submit} className="mx-auto max-w-md space-y-3 text-left">
      {heading && <h3 className="text-center text-base font-semibold text-[var(--text-primary)]">{heading}</h3>}
      {blurb && <p className="text-center text-sm text-[var(--text-secondary)]">{blurb}</p>}

      {/* Honeypot. Hidden from people, irresistible to bots. Not display:none —
          some bots skip those; off-screen with aria-hidden works on both. */}
      <div aria-hidden className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input type="text" tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <input required disabled={busy} className={field} placeholder="Your name" value={form.name} onChange={set('name')} autoComplete="name" />
        <input required disabled={busy} className={field} placeholder="you@company.com" type="email" value={form.email} onChange={set('email')} autoComplete="email" />
      </div>
      <input disabled={busy} className={field} placeholder="Company (optional)" value={form.company} onChange={set('company')} autoComplete="organization" />
      <textarea
        required disabled={busy} rows={4} className={field}
        placeholder={intent === 'demo request' ? 'What would you like to see? Brands, channels, team size…' : 'What are you working on?'}
        value={form.message} onChange={set('message')}
      />

      {error && (
        <p className="flex items-start gap-1.5 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <span aria-hidden>⚠</span><span>{error}</span>
        </p>
      )}

      <button
        type="submit" disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--ink)] px-5 py-2.5 text-sm font-semibold text-[var(--ink-fg)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-70"
      >
        {busy && (
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        )}
        {busy ? 'Sending…' : intent === 'demo request' ? 'Book a demo' : 'Request access'}
      </button>
      <p className="text-center text-xs text-[var(--text-muted)]">
        We use this only to reply. No list, no sequence.
      </p>
    </form>
  );
}
