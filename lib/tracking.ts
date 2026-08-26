// ============================================================
// Open/click tracking (gap #2). Signed, tamper-proof tokens so a public
// tracking endpoint can attribute an open/click to (account, contact,
// enrollment, step) without trusting the URL. HMAC-SHA256 over the payload,
// same primitive as lib/session. No PII in the token beyond internal ids.
// ============================================================
const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function key(): Promise<CryptoKey> {
  const secret = process.env.APP_SESSION_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('APP_SESSION_SECRET is required in production');
  }
  const effective = secret || 'dev-insecure-secret-change-me';
  return crypto.subtle.importKey('raw', enc.encode(effective), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export interface TrackCtx {
  a?: string; // accountId
  c?: string; // contactId
  e?: string; // enrollmentId
  s?: string; // stepId
}

export async function signTrack(ctx: TrackCtx): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(ctx)));
  const sig = b64url(await crypto.subtle.sign('HMAC', await key(), enc.encode(payload)));
  return `${payload}.${sig}`;
}

export async function verifyTrack(token?: string | null): Promise<TrackCtx | null> {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  try {
    const ok = await crypto.subtle.verify('HMAC', await key(), fromB64url(sig) as unknown as BufferSource, enc.encode(payload));
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(fromB64url(payload))) as TrackCtx;
  } catch {
    return null;
  }
}

function appBaseUrl(): string {
  return (
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    // APP_BASE_URL is the authoritative one for this deployment; the others are
    // legacy aliases kept so an older env file still resolves.
    process.env.APP_BASE_URL ||
    ''
  ).replace(/\/$/, '');
}

/**
 * Inject an open pixel and rewrite anchor hrefs to the click-tracking endpoint.
 * No-ops (returns html unchanged) when no base URL is configured, so a
 * misconfigured env never breaks the actual send.
 */
export async function injectTracking(html: string, ctx: TrackCtx): Promise<string> {
  const base = appBaseUrl();
  if (!base) return html;
  const token = await signTrack(ctx);

  // Rewrite http(s) links → /api/track/click/<token>?u=<encoded original>
  let out = html.replace(/(<a\b[^>]*?\bhref=)("|')(https?:\/\/[^"']+)\2/gi, (_m, pre, q, url) => {
    const wrapped = `${base}/api/track/click/${token}?u=${encodeURIComponent(url)}`;
    return `${pre}${q}${wrapped}${q}`;
  });

  // Append a 1x1 open pixel.
  const pixel = `<img src="${base}/api/track/open/${token}" width="1" height="1" alt="" style="display:none" />`;
  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `${pixel}</body>`);
  else out += pixel;
  return out;
}
