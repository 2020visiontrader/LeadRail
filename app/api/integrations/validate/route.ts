import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady, upsertConnection } from '@/lib/db';
import { storeSocialCredential, type TokenProvider } from '@/lib/social/credentials';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function fetchJson(url: string, headers: Record<string, string>) {
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

async function validateMeta(token: string) {
  const data = await fetchJson(
    `https://graph.facebook.com/v18.0/me?access_token=${encodeURIComponent(token)}&fields=id,name`,
    {}
  );
  // Best-effort: resolve the Instagram Business account id so publishing works without a second step.
  let igUserId: string | undefined;
  let pageId: string | undefined;
  try {
    const pages = await fetchJson(
      `https://graph.facebook.com/v18.0/me/accounts?fields=id,name,instagram_business_account&access_token=${encodeURIComponent(token)}`,
      {}
    );
    const withIg = (Array.isArray(pages?.data) ? pages.data : []).find((p: any) => p?.instagram_business_account?.id);
    if (withIg) {
      pageId = withIg.id;
      igUserId = withIg.instagram_business_account.id;
    } else if (Array.isArray(pages?.data) && pages.data[0]?.id) {
      pageId = pages.data[0].id;
    }
  } catch {
    // token may lack pages_show_list scope; store what we have
  }
  return { id: data.id, name: data.name, platform: 'meta', igUserId, pageId };
}

async function validatePostiz(token: string) {
  const data = await fetchJson(
    'https://api.postiz.com/public/v1/integrations',
    { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  );
  const first = Array.isArray(data) ? data[0] : data;
  return { id: first?.id || 'connected', name: first?.name || 'Postiz account', platform: 'postiz' };
}

async function validateTiktok(token: string) {
  const data = await fetchJson(
    `https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name`,
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  );
  const user = data?.data?.user;
  return { id: user?.open_id, name: user?.display_name || 'TikTok account', platform: 'tiktok' };
}

async function validateResend(token: string) {
  // Resend "sending-restricted" keys can only POST /emails — every GET endpoint
  // returns 401 even for a valid key. So we can't probe without sending. Validate
  // by key structure (re_...) and defer the real check to first send.
  if (!/^re_[A-Za-z0-9_-]{10,}$/.test(token)) {
    throw new Error('HTTP 400: not a Resend API key (expected re_… prefix)');
  }
  // Best-effort probe: if the key happens to be a full-access key, GET /domains
  // returns 200 and gives us a nicer name; a 401 here is expected for restricted keys.
  try {
    const r = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (r.ok) {
      const d = await r.json().catch(() => null);
      const domain = d?.data?.[0]?.name;
      return { id: 'connected', name: domain ? `Resend (${domain})` : 'Resend account', platform: 'resend' };
    }
  } catch {
    // network hiccup — still accept a structurally-valid key
  }
  return { id: 'connected', name: 'Resend account (send-only key)', platform: 'resend' };
}

async function validateNotion(token: string) {
  // A Notion internal-integration secret (ntn_… / secret_…) is long-lived, so
  // pasting it is a real "connect your own account" — no OAuth app needed.
  const data = await fetchJson('https://api.notion.com/v1/users/me', {
    Authorization: `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
  });
  const name = data?.name || data?.bot?.owner?.user?.name || 'Notion workspace';
  return { id: data?.id || 'connected', name, platform: 'notion' };
}

/**
 * Buffer — Packet 7.2. Probing `list_channels` with the pasted key both proves
 * the key works and names the organisation, which becomes the connection's
 * external_id (Buffer calls are organisation-scoped, and the agent's
 * `listScheduledSocialPosts` passes it straight through).
 */
async function validateBuffer(token: string): Promise<ValidatorResult> {
  const r = await fetch('https://mcp.buffer.com/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: '1', method: 'tools/call',
      params: { name: 'list_channels', arguments: {} },
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  const data = await r.json().catch(() => null);
  const text = (data?.result?.content || []).find((c: any) => c?.type === 'text')?.text;
  let channels: any = null;
  try { channels = text ? JSON.parse(text) : null; } catch { channels = null; }
  const list = Array.isArray(channels) ? channels : channels?.channels;
  const orgId = (Array.isArray(list) ? list : []).find((c: any) => c?.organizationId || c?.organization_id);
  return {
    id: String(orgId?.organizationId || orgId?.organization_id || 'buffer'),
    name: 'Buffer account',
    platform: 'buffer',
  };
}

/**
 * GoHighLevel — Packet 7.2. The token is a location-scoped Private Integration
 * Token, so validating it needs the location id; the agency-wide
 * `/locations/search` endpoint returns 403 for a PIT and cannot be used.
 */
async function validateGhl(token: string, body: any): Promise<ValidatorResult> {
  const locationId = String(body?.locationId || '');
  if (!locationId) throw new Error('HTTP 400: locationId is required to connect GoHighLevel');
  await fetchJson(
    `https://services.leadconnectorhq.com/social-media-posting/${encodeURIComponent(locationId)}/accounts`,
    { Authorization: `Bearer ${token}`, Version: '2023-02-21', Accept: 'application/json' },
  );
  return { id: locationId, name: `GoHighLevel (${locationId})`, platform: 'ghl', locationId };
}

type ValidatorResult = {
  id: string; name: string; platform: string;
  igUserId?: string; pageId?: string; locationId?: string;
};

const VALIDATORS: Record<string, (token: string, body: any) => Promise<ValidatorResult>> = {
  meta: validateMeta,
  postiz: validatePostiz,
  tiktok: validateTiktok,
  resend: validateResend,
  notion: validateNotion,
  buffer: validateBuffer,
  ghl: validateGhl,
};

/**
 * Providers whose token goes into the ENCRYPTED column instead of `meta`
 * (Packet 7.2). `meta` is returned to the browser through the /api/integrations
 * projection and is writable from a request body; a long-lived third-party
 * token belongs in neither. These are stored via storeSocialCredential, which
 * encrypts with the lib/ai/crypto vault before the value reaches Postgres.
 *
 * The other providers above still write `meta.access_token` — that predates
 * this packet and is reported, not silently changed here.
 */
const VAULTED: Record<string, TokenProvider> = { buffer: 'buffer', ghl: 'ghl' };

async function POST__impl(request: NextRequest) {
  const { session, error: authErr } = await requireSession(request);
  if (authErr) return authErr;

  try {
    const body = await request.json();
    const provider = String(body?.provider || '');
    const token = String(body?.token || '');

    if (!provider || !token) return badRequest('provider and token are required');

    const validate = VALIDATORS[provider];
    if (!validate) return NextResponse.json({ error: `Unsupported provider: ${provider}` }, { status: 400 });

    const result = await validate(token, body);

    const response: any = {
      ok: true,
      provider,
      external_name: result.name,
      external_id: result.id,
    };

    // account_id is authoritative from the session, never the client body.
    const accountId = session.accountId;

    // Packet 7.2: Buffer / GHL tokens go to the encrypted column, scoped to this
    // session's account. Nothing about the token is echoed back.
    const vaulted = VAULTED[provider];
    if (vaulted) {
      if (!dbReady()) return badRequest('database not connected');
      await storeSocialCredential(accountId, vaulted, token, {
        externalId: result.id,
        displayName: result.name,
        meta: {
          platform_name: result.name,
          last_validated: new Date().toISOString(),
          ...(result.locationId ? { locationId: result.locationId } : {}),
        },
      });
      return NextResponse.json(response);
    }

    if (dbReady()) {
      const metaPayload: Record<string, any> = {
        platform_id: result.id,
        platform_name: result.name,
        last_validated: new Date().toISOString(),
        // Persist the validated token so publish/send paths can use it per-account.
        access_token: token,
      };
      if (result.igUserId) metaPayload.ig_user_id = result.igUserId;
      if (result.pageId) metaPayload.page_id = result.pageId;

      const row = await upsertConnection({
        account_id: accountId,
        provider,
        status: 'connected',
        meta: metaPayload,
        secret_ref: `user-provided:${provider}`,
      });
      // Never leak the raw token back to the client.
      if (row?.meta?.access_token) row.meta = { ...row.meta, access_token: '***stored***' };
      response.connection = row;
      if (provider === 'meta') response.ig_linked = Boolean(result.igUserId);
    }

    return NextResponse.json(response);

  } catch (error: any) {
    if (error.message?.includes('HTTP 4')) {
      return NextResponse.json({ error: `Token rejected by provider: ${error.message}` }, { status: 401 });
    }
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/integrations/validate", method: "POST" });
