// tests/contact-route.test.ts — the public contact endpoint.
//
// This is the marketing site's only working contact channel now that the
// `mailto:` links are gone, so a silent failure here means inbound leads
// disappear with nobody noticing — which is exactly what the mailto did.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sent: any[] = [];
const state = { fail: false };

vi.mock('@/lib/integrations/resend', () => ({
  sendPlatformEmail: async (email: any) => {
    if (state.fail) throw new Error('resend: domain not verified');
    sent.push(email);
    return { id: 'sent' };
  },
}));
vi.mock('@/lib/logger', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {}, request: () => {} },
}));
vi.mock('@/lib/http', async () => ({
  withApi: (h: any) => h,
  errorResponse: (e: any) => new Response(String(e), { status: 500 }),
  badRequest: (m: string) => new Response(m, { status: 400 }),
}));

const { POST } = await import('@/app/api/contact/route');
const { __resetRateLimits } = await import('@/lib/rate-limit');

let ipCounter = 0;
function post(body: any, ip?: string) {
  // Unique IP per call by default so validation tests never trip the limiter.
  const addr = ip ?? `10.0.0.${++ipCounter % 250}`;
  return POST(new Request('https://app.leadrail.xyz/api/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': addr },
    body: JSON.stringify(body),
  }) as any);
}

const VALID = { name: 'Dana Reed', email: 'dana@northwind.co', company: 'Northwind', message: 'We run three brands and want to see the assistant work.' };

beforeEach(() => { sent.length = 0; state.fail = false; __resetRateLimits(); });

describe('a real enquiry gets through', () => {
  it('accepts it and sends exactly one email', async () => {
    const res = await post({ ...VALID, intent: 'demo request' });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('sets reply-to to the sender but keeps From on our own domain', async () => {
    // Putting a stranger's address in From is how a sending domain loses its
    // reputation — it fails SPF/DKIM alignment and gets marked as spoofing.
    await post(VALID);
    expect(sent[0].replyTo).toBe('dana@northwind.co');
    expect(sent[0].from).not.toContain('northwind.co');
    expect(sent[0].to).toBeTruthy();
  });

  it('carries the name, company and intent so the reply has context', async () => {
    await post({ ...VALID, intent: 'access request' });
    expect(sent[0].subject).toContain('Dana Reed');
    expect(sent[0].subject).toContain('Northwind');
    expect(sent[0].subject).toContain('access request');
  });
});

describe('input is validated before anything is sent', () => {
  it.each([
    ['no name', { ...VALID, name: '' }],
    ['bad email', { ...VALID, email: 'not-an-address' }],
    ['message too short', { ...VALID, message: 'hi' }],
  ])('rejects %s without sending', async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('survives a malformed body instead of throwing', async () => {
    const res = await POST(new Request('https://app.leadrail.xyz/api/contact', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.9' }, body: '{not json',
    }) as any);
    expect(res.status).toBe(400);
  });

  it('escapes HTML so the email body cannot be injected', async () => {
    await post({ ...VALID, name: '<script>alert(1)</script>', message: 'Interested in <b>everything</b> you build.' });
    expect(sent[0].html).not.toContain('<script>');
    expect(sent[0].html).toContain('&lt;script&gt;');
  });
});

describe('bots and floods', () => {
  it('swallows a honeypot submission without sending, and looks like success', async () => {
    // Answering 400 would tell the bot which field caught it.
    const res = await post({ ...VALID, website: 'http://spam.example' });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it('rate-limits one IP and tells it when to come back', async () => {
    for (let i = 0; i < 5; i++) expect((await post(VALID, '203.0.113.5')).status).toBe(200);
    const res = await post(VALID, '203.0.113.5');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(sent).toHaveLength(5);
  });

  it('does not punish a different sender for that flood', async () => {
    for (let i = 0; i < 6; i++) await post(VALID, '203.0.113.5');
    expect((await post(VALID, '203.0.113.99')).status).toBe(200);
  });
});

describe('when sending fails', () => {
  it('does not claim success, and does not blame the sender', async () => {
    state.fail = true;
    const res = await post(VALID);
    expect(res.status).toBe(502);
    const body = await res.json();
    // A missing key or unverified domain is OUR problem; telling the visitor to
    // "try again" sends them into a loop that cannot succeed.
    expect(body.error).toMatch(/email us directly/i);
  });
});
