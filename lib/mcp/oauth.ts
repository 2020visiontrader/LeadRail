// OAuth for external MCP servers.
//
// WHAT THIS IMPLEMENTS. The MCP authorization flow: discover the resource's
// authorization server, register as a client if we have not already, run
// authorization-code with PKCE, store the tokens encrypted, and refresh them.
// Four specs stacked — RFC 9728 (protected-resource metadata), RFC 8414
// (authorization-server metadata), RFC 7591 (dynamic client registration) and
// RFC 7636 (PKCE) — because a public client talking to a server it has never
// met has no other way to obtain a credential.
//
// WHY PKCE IS MANDATORY HERE, not optional. Dynamic registration usually
// produces a PUBLIC client: no client_secret, because there is nowhere to put
// one that the authorization server could verify. Without PKCE, an
// authorization code intercepted on the redirect can be exchanged by anyone
// holding it. The verifier is what binds the code to the session that
// requested it, so it is generated per attempt, stored server-side only
// (migration 053), and never leaves this process.
//
// WHAT THIS DOES NOT DO. It does not fall back to an unauthenticated request
// when discovery fails, and it does not guess endpoint URLs from the MCP host.
// A server that does not publish its metadata is reported as such — inventing
// `/authorize` and hoping produces a redirect to a page that may not be the
// right authorization server at all, which is a phishing vector, not a
// convenience.
//
// UNTESTED AGAINST A LIVE SERVER. This sandbox's egress policy blocks the
// hosts this talks to, so every path below is written against the specs and
// has not completed a real handshake. The failure messages are deliberately
// specific about WHICH step failed so the first real attempt is diagnosable.

import { createHash, randomBytes } from 'node:crypto';
import { supabase, dbReady } from '@/lib/db';
import { encryptSecret, decryptSecret, vaultConfigured } from '@/lib/ai/crypto';

const DISCOVERY_TIMEOUT_MS = 8000;
const TOKEN_TIMEOUT_MS = 10000;

/** Refresh this long before stated expiry, so a call in flight does not race
 *  the token going stale mid-request. */
const REFRESH_SKEW_MS = 60_000;

export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON handled below */ }
  if (!res.ok) {
    const detail = (json?.error_description || json?.error || text || res.statusText || '').toString().slice(0, 200);
    const err: any = new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }
  if (!json) throw new Error('the response was not JSON');
  return json;
}

/** Build a .well-known URL correctly for a path-bearing resource.
 *
 *  RFC 9728 inserts the well-known segment after the ORIGIN and keeps the
 *  path — so `https://host/mcp` looks up
 *  `https://host/.well-known/oauth-protected-resource/mcp`, not
 *  `https://host/mcp/.well-known/...`. Getting this wrong 404s on every
 *  spec-compliant server, which then looks like "the server has no metadata". */
function wellKnown(base: URL, suffix: string): string[] {
  const withPath = base.pathname && base.pathname !== '/'
    ? `${base.origin}/.well-known/${suffix}${base.pathname}`
    : `${base.origin}/.well-known/${suffix}`;
  const atRoot = `${base.origin}/.well-known/${suffix}`;
  // Try the path-aware form first, then the root form — some servers only
  // publish the latter.
  return withPath === atRoot ? [atRoot] : [withPath, atRoot];
}

/** Ask the MCP endpoint itself where its metadata lives.
 *
 *  THIS IS THE STEP THAT WAS MISSING, and it is not an optimisation. The spec
 *  lets a server implement EITHER of two discovery mechanisms: the
 *  WWW-Authenticate header on a 401, or the well-known URI. A client that only
 *  implements the second one fails completely against a server that chose the
 *  first — and fails in the most misleading way possible, reporting "no
 *  metadata found" about a server that is publishing its metadata correctly
 *  and telling us exactly where it is.
 *
 *  RFC 9728 §5.1: `WWW-Authenticate: Bearer resource_metadata="https://..."`.
 *  The 401 is the expected, successful outcome of this probe — we are reading
 *  the challenge, not trying to get past it.
 *
 *  Returns null rather than throwing: this is one of two routes, and a server
 *  that answers without the header is still reachable through the other. */
async function resourceMetadataUrlFromChallenge(mcpUrl: string): Promise<string | null> {
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      // A well-formed initialize, so a server that authenticates per-method
      // reaches the same 401 a real client would.
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'LeadRail', version: '1.0' } },
      }),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    const header = res.headers.get('www-authenticate');
    if (!header) return null;
    // resource_metadata="<url>" — quoted per RFC 7235, but accept unquoted too
    // rather than failing on a server that is merely untidy about it.
    const m = header.match(/resource_metadata\s*=\s*"([^"]+)"/i)
      || header.match(/resource_metadata\s*=\s*([^,\s]+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Find the authorization server protecting an MCP endpoint.
 *
 * Three routes, in the order the spec prefers them:
 *   1. the WWW-Authenticate challenge on a 401 — authoritative, the server
 *      naming its own metadata document
 *   2. the well-known protected-resource URI
 *   3. assume the MCP host is its own issuer
 *
 * Route 1 first because it is the only one that cannot be wrong: 2 and 3 are
 * both guesses about where a document might live, and a guess that happens to
 * hit a DIFFERENT authorization server would send the user to sign in
 * somewhere they did not intend.
 */
export async function discoverAuthServer(mcpUrl: string): Promise<AuthServerMetadata> {
  let base: URL;
  try { base = new URL(mcpUrl); } catch { throw new Error('The server URL is not a valid URL.'); }

  const issuers: string[] = [];

  const advertised = await resourceMetadataUrlFromChallenge(mcpUrl);
  if (advertised) {
    try {
      const prm = await fetchJson(advertised, { headers: { Accept: 'application/json' } }, DISCOVERY_TIMEOUT_MS);
      const list = Array.isArray(prm?.authorization_servers) ? prm.authorization_servers : [];
      for (const i of list) if (typeof i === 'string') issuers.push(i);
    } catch { /* fall through to the well-known route */ }
  }

  for (const url of issuers.length ? [] : wellKnown(base, 'oauth-protected-resource')) {
    try {
      const prm = await fetchJson(url, { headers: { Accept: 'application/json' } }, DISCOVERY_TIMEOUT_MS);
      const list = Array.isArray(prm?.authorization_servers) ? prm.authorization_servers : [];
      for (const i of list) if (typeof i === 'string') issuers.push(i);
      if (issuers.length) break;
    } catch { /* try the next candidate */ }
  }
  // No protected-resource document: assume the MCP host is its own issuer.
  if (!issuers.length) issuers.push(base.origin);

  const errors: string[] = [];
  for (const issuer of issuers) {
    let issuerUrl: URL;
    try { issuerUrl = new URL(issuer); } catch { continue; }
    // Both metadata documents, because an OpenID-Connect issuer publishes the
    // second and not the first.
    const candidates = [
      ...wellKnown(issuerUrl, 'oauth-authorization-server'),
      ...wellKnown(issuerUrl, 'openid-configuration'),
    ];
    for (const url of candidates) {
      try {
        const meta = await fetchJson(url, { headers: { Accept: 'application/json' } }, DISCOVERY_TIMEOUT_MS);
        if (meta?.authorization_endpoint && meta?.token_endpoint) {
          return {
            issuer: meta.issuer || issuer,
            authorization_endpoint: meta.authorization_endpoint,
            token_endpoint: meta.token_endpoint,
            registration_endpoint: meta.registration_endpoint,
            scopes_supported: meta.scopes_supported,
            code_challenge_methods_supported: meta.code_challenge_methods_supported,
          };
        }
      } catch (e: any) {
        errors.push(`${url} → ${e?.message || e}`);
      }
    }
  }
  throw new Error(
    `Could not find an authorization server for ${base.host}. ` +
    (advertised
      ? `The server pointed at ${advertised}, but that document did not name an authorization server. `
      : 'The server did not advertise one on a 401, and no metadata document was published where the spec says to look. ') +
    `Tried: ${errors.slice(0, 3).join(' · ') || 'no metadata documents found'}. ` +
    'If this server uses a static token instead of OAuth, register it with an Auth header rather than Connect.',
  );
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

export interface RegisteredClient {
  client_id: string;
  client_secret?: string;
}

export async function registerClient(
  meta: AuthServerMetadata,
  redirectUri: string,
  clientName = 'LeadRail',
): Promise<RegisteredClient> {
  if (!meta.registration_endpoint) {
    throw new Error(
      'That authorization server does not support automatic client registration, ' +
      'so it needs a client id issued by hand. Register LeadRail with the provider and add the server with an Auth header instead.',
    );
  }
  const body = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    // 'none' declares a PUBLIC client: we hold no secret the server could
    // verify, which is exactly why PKCE carries the security here.
    token_endpoint_auth_method: 'none',
    ...(meta.scopes_supported?.length ? { scope: meta.scopes_supported.join(' ') } : {}),
  };
  const json = await fetchJson(
    meta.registration_endpoint,
    { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) },
    TOKEN_TIMEOUT_MS,
  );
  if (!json?.client_id) throw new Error('Client registration returned no client_id.');
  return { client_id: String(json.client_id), client_secret: json.client_secret ? String(json.client_secret) : undefined };
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createPkce(): { verifier: string; challenge: string } {
  // 32 random bytes → 43 base64url chars, the length RFC 7636 recommends.
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function createState(): string {
  return base64url(randomBytes(24));
}

// ---------------------------------------------------------------------------
// Authorization + token exchange
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(opts: {
  meta: AuthServerMetadata;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scope?: string;
  /** The MCP endpoint this token is for. RFC 8707; servers that implement it
   *  bind the token to this resource, which stops a token minted for one MCP
   *  server being replayed against another. */
  resource?: string;
}): string {
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
  });
  if (opts.scope) p.set('scope', opts.scope);
  if (opts.resource) p.set('resource', opts.resource);
  const sep = opts.meta.authorization_endpoint.includes('?') ? '&' : '?';
  return `${opts.meta.authorization_endpoint}${sep}${p.toString()}`;
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export async function exchangeCode(opts: {
  meta: AuthServerMetadata;
  clientId: string;
  clientSecret?: string;
  code: string;
  redirectUri: string;
  verifier: string;
  resource?: string;
}): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.verifier,
  });
  if (opts.resource) form.set('resource', opts.resource);
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  // A confidential client authenticates on the token endpoint; a public one
  // does not send anything, and PKCE is what proves the request is genuine.
  if (opts.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')}`;
  }
  const json = await fetchJson(opts.meta.token_endpoint, { method: 'POST', headers, body: form.toString() }, TOKEN_TIMEOUT_MS);
  if (!json?.access_token) throw new Error('The token endpoint returned no access_token.');
  return json as TokenSet;
}

export async function refreshAccessToken(opts: {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  resource?: string;
}): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
  });
  if (opts.resource) form.set('resource', opts.resource);
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (opts.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')}`;
  }
  const json = await fetchJson(opts.tokenUrl, { method: 'POST', headers, body: form.toString() }, TOKEN_TIMEOUT_MS);
  if (!json?.access_token) throw new Error('The refresh returned no access_token.');
  return json as TokenSet;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function requireVault() {
  if (!vaultConfigured()) {
    const err: any = new Error('AI_VAULT_KEY is not set on this deployment; OAuth tokens cannot be stored.');
    err.code = 'vault_not_configured';
    throw err;
  }
}

/** Record a pending authorization attempt. Returns nothing — the caller already
 *  holds the state value it needs. */
export async function saveAuthState(input: {
  state: string; accountId: string; clientId: string; verifier: string; redirectUri: string;
}): Promise<void> {
  const { error } = await supabase.from('mcp_oauth_states').insert([{
    state: input.state,
    account_id: input.accountId,
    client_id: input.clientId,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
  }]);
  if (error) throw error;
}

/**
 * Consume a pending attempt: read it, delete it, and refuse it if expired.
 *
 * Single-use by construction — the delete happens before the caller does
 * anything with the result, so a replayed callback finds nothing. That is the
 * whole CSRF and code-replay defence, so it must not be softened into "look up
 * and maybe delete later".
 */
export async function consumeAuthState(state: string): Promise<{
  accountId: string; clientId: string; verifier: string; redirectUri: string;
} | null> {
  if (!state) return null;
  const { data, error } = await supabase
    .from('mcp_oauth_states').select('*').eq('state', state).maybeSingle();
  if (error || !data) return null;
  await supabase.from('mcp_oauth_states').delete().eq('state', state);
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  return {
    accountId: data.account_id,
    clientId: data.client_id,
    verifier: data.code_verifier,
    redirectUri: data.redirect_uri,
  };
}

/** Best-effort sweep of abandoned attempts. Called opportunistically rather
 *  than on a schedule — the rows are tiny and expiry is already enforced on
 *  read, so this is hygiene, not correctness. */
export async function purgeExpiredAuthStates(): Promise<void> {
  try {
    await supabase.from('mcp_oauth_states').delete().lt('expires_at', new Date().toISOString());
  } catch { /* hygiene only */ }
}

export async function saveDiscovery(accountId: string, clientRowId: string, meta: AuthServerMetadata, reg: RegisteredClient, scope?: string): Promise<void> {
  requireVault();
  const patch: Record<string, any> = {
    auth_mode: 'oauth',
    oauth_issuer: meta.issuer,
    oauth_authorize_url: meta.authorization_endpoint,
    oauth_token_url: meta.token_endpoint,
    oauth_registration_url: meta.registration_endpoint ?? null,
    oauth_client_id: reg.client_id,
    oauth_scope: scope ?? null,
    updated_at: new Date().toISOString(),
  };
  if (reg.client_secret) patch.oauth_client_secret_encrypted = encryptSecret(reg.client_secret);
  const { error } = await supabase.from('mcp_clients').update(patch).eq('id', clientRowId).eq('account_id', accountId);
  if (error) throw error;
}

export async function saveTokens(accountId: string, clientRowId: string, tokens: TokenSet): Promise<void> {
  requireVault();
  const patch: Record<string, any> = {
    auth_mode: 'oauth',
    oauth_access_token_encrypted: encryptSecret(tokens.access_token),
    oauth_connected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  // A refresh token is NOT always reissued on refresh. Overwriting with null
  // when the server omits it would silently downgrade the connection to
  // one-shot, so an absent value leaves the stored one alone.
  if (tokens.refresh_token) patch.oauth_refresh_token_encrypted = encryptSecret(tokens.refresh_token);
  patch.oauth_expires_at = tokens.expires_in
    ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString()
    : null;
  if (tokens.scope) patch.oauth_scope = tokens.scope;

  const { error } = await supabase.from('mcp_clients').update(patch).eq('id', clientRowId).eq('account_id', accountId);
  if (error) throw error;
}

/**
 * The access token to send for a connection, refreshing first when it is
 * expired or about to be.
 *
 * Returns null when the connection is not OAuth or has never been authorized —
 * the caller falls back to the static header, so a header-mode server is
 * completely unaffected by any of this.
 */
export async function getAccessToken(accountId: string, clientRowId: string): Promise<string | null> {
  if (!dbReady()) return null;
  const { data, error } = await supabase
    .from('mcp_clients').select('*').eq('id', clientRowId).eq('account_id', accountId).maybeSingle();
  if (error || !data) return null;
  if (data.auth_mode !== 'oauth' || !data.oauth_access_token_encrypted) return null;

  const expiresAt = data.oauth_expires_at ? new Date(data.oauth_expires_at).getTime() : null;
  const stale = expiresAt !== null && expiresAt - REFRESH_SKEW_MS < Date.now();

  if (stale && data.oauth_refresh_token_encrypted && data.oauth_token_url) {
    try {
      const tokens = await refreshAccessToken({
        tokenUrl: data.oauth_token_url,
        clientId: data.oauth_client_id,
        clientSecret: data.oauth_client_secret_encrypted ? decryptSecret(data.oauth_client_secret_encrypted) : undefined,
        refreshToken: decryptSecret(data.oauth_refresh_token_encrypted),
        resource: data.url,
      });
      await saveTokens(accountId, clientRowId, tokens);
      return tokens.access_token;
    } catch {
      // Refresh failed — hand back the stale token rather than nothing. It may
      // still work (servers are lenient about skew), and if it does not the
      // call returns 401, which is a clearer signal than "not connected".
      return decryptSecret(data.oauth_access_token_encrypted);
    }
  }
  return decryptSecret(data.oauth_access_token_encrypted);
}

/** Clear an authorization without deleting the server row, so a reconnect
 *  reuses the existing registration. */
export async function disconnectOauth(accountId: string, clientRowId: string): Promise<void> {
  await supabase.from('mcp_clients').update({
    oauth_access_token_encrypted: null,
    oauth_refresh_token_encrypted: null,
    oauth_expires_at: null,
    oauth_connected_at: null,
    updated_at: new Date().toISOString(),
  }).eq('id', clientRowId).eq('account_id', accountId);
}
