import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { sendPlatformEmail } from '@/lib/integrations/resend';
import { rateLimit, clientIp } from '@/lib/rate-limit';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/contact — the demo/access request form on the marketing site.
//
// Replaces seven `mailto:` links that pointed at a personal Gmail address. A
// mailto is not a contact channel: it publishes a private inbox on every legal
// page, it dies silently for anyone without a configured mail client, and it
// leaves no record that the request happened.
//
// PUBLIC and unauthenticated, so it is rate-limited by IP. The reply-to is set
// to the sender so a reply goes back to them, but the FROM stays on LeadRail's
// verified domain — putting a stranger's address in From is how a domain gets
// its sending reputation destroyed.
const FROM = process.env.CONTACT_FROM || 'LeadRail <hello@leadrail.xyz>';
const INBOX = process.env.CONTACT_INBOX || 'hello@leadrail.xyz';

const MAX = { name: 120, email: 254, company: 160, message: 4000 } as const;

function clean(v: unknown, cap: number): string {
  return typeof v === 'string' ? v.trim().slice(0, cap) : '';
}

// Deliberately permissive: the goal is to reject obvious junk, not to
// adjudicate RFC 5322. A real address that fails a clever regex is a lost lead.
function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(v);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

async function POST__impl(request: NextRequest) {
  // 5 per 10 minutes per IP. A real person sends one; a loop or a scraper
  // trips it long before it costs anything.
  const limited = rateLimit(`contact:${clientIp(request)}`, 5, 10 * 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  // Honeypot: a field hidden from humans by CSS. Anything that fills it is a
  // bot. Answer 200 so the bot cannot tell it was caught and retry differently.
  if (clean(body?.website, 200)) {
    log.warn('contact: honeypot tripped', { ip: clientIp(request) });
    return NextResponse.json({ ok: true });
  }

  const name = clean(body?.name, MAX.name);
  const email = clean(body?.email, MAX.email).toLowerCase();
  const company = clean(body?.company, MAX.company);
  const message = clean(body?.message, MAX.message);
  const intent = clean(body?.intent, 40) || 'general';

  if (!name) return NextResponse.json({ error: 'Please tell us your name.' }, { status: 400 });
  if (!looksLikeEmail(email)) return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 });
  if (message.length < 10) return NextResponse.json({ error: 'Please add a little more detail.' }, { status: 400 });

  const subject = `LeadRail ${intent} — ${name}${company ? ` (${company})` : ''}`;
  const html = [
    `<p><strong>${esc(name)}</strong>${company ? ` — ${esc(company)}` : ''}</p>`,
    `<p>${esc(email)}</p>`,
    `<p><em>Intent: ${esc(intent)}</em></p>`,
    '<hr>',
    `<p style="white-space:pre-wrap">${esc(message)}</p>`,
  ].join('\n');

  try {
    await sendPlatformEmail({ from: FROM, to: INBOX, subject, html, replyTo: email } as any);
  } catch (e) {
    // The sender must not be told to "try again" when retrying cannot help —
    // a missing API key or unverified domain is our problem, not theirs. Logged
    // with the detail so it is diagnosable without exposing it to the caller.
    log.error('contact: send failed', e, { intent, hasKey: Boolean(process.env.LEADRAIL_RESEND_API_KEY) });
    return NextResponse.json(
      { error: 'We could not send that just now. Please email us directly and we will pick it up.' },
      { status: 502 },
    );
  }

  log.info('contact: received', { intent, company: company || null });
  return NextResponse.json({ ok: true });
}

export const POST = withApi(POST__impl as any, { route: '/api/contact', method: 'POST' });
