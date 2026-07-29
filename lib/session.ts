// Signed session token (HMAC-SHA256), isomorphic: usable in edge middleware and node routes.
const enc = new TextEncoder();
function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = ''; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function key(): Promise<CryptoKey> {
  const secret = process.env.APP_SESSION_SECRET || 'dev-insecure-secret-change-me';
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export interface Session { email: string; accountId: string; role: string; exp: number; }

export async function signSession(s: Session): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify(s)));
  const sig = b64url(await crypto.subtle.sign('HMAC', await key(), enc.encode(payload)));
  return `${payload}.${sig}`;
}
export async function verifySession(token?: string | null): Promise<Session | null> {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  try {
    const ok = await crypto.subtle.verify('HMAC', await key(), fromB64url(sig) as unknown as BufferSource, enc.encode(payload));
    if (!ok) return null;
    const s = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as Session;
    if (!s.exp || s.exp < Date.now()) return null;
    return s;
  } catch { return null; }
}
export const SESSION_COOKIE = 'ma_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days
