// Notion connector (API). Token resolution is multi-source and honest: a
// per-account connection row wins, then the process env. No token → the
// verifier reports "not connected" instead of throwing, so Settings can show
// an accurate state. The same token powers the agent's notionSearch tool.

import { getConnection } from '@/lib/db';
import { resolveTokensForRow } from '@/lib/social/connection-token';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

export async function resolveNotionToken(accountId?: string): Promise<string | null> {
  if (accountId) {
    try {
      const conn = await getConnection(accountId, 'notion');
      if (conn) {
        const { accessToken } = await resolveTokensForRow(conn);
        if (accessToken) return accessToken;
      }
    } catch { /* fall through to env */ }
  }
  return process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || null;
}

async function notion(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`${NOTION_API}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.message || `Notion error (${res.status})`);
  return json;
}

export interface NotionVerifyResult {
  connected: boolean;
  workspaceUser?: string;
  botId?: string;
  error?: string;
}

/** Prove the token works by fetching the bot user. Never throws — returns a status. */
export async function verifyNotion(accountId?: string): Promise<NotionVerifyResult> {
  const token = await resolveNotionToken(accountId);
  if (!token) return { connected: false, error: 'No Notion token — add a Notion integration secret to connect.' };
  try {
    const me = await notion('users/me', token);
    return { connected: true, workspaceUser: me?.name || me?.bot?.owner?.user?.name || 'Notion bot', botId: me?.id };
  } catch (e: any) {
    return { connected: false, error: e?.message || 'Notion verification failed' };
  }
}

export interface NotionHit { id: string; title: string; url?: string; type: string }

/** Search pages/databases the integration can see. */
export async function notionSearch(accountId: string, query: string, limit = 10): Promise<NotionHit[]> {
  const token = await resolveNotionToken(accountId);
  if (!token) throw new Error('Notion is not connected — add a Notion integration secret in Settings.');
  const json = await notion('search', token, {
    method: 'POST',
    body: JSON.stringify({ query, page_size: Math.min(limit, 50) }),
  });
  return (json.results || []).map((r: any) => {
    const props = r.properties || {};
    const titleProp = Object.values(props).find((p: any) => p?.type === 'title') as any;
    const title =
      titleProp?.title?.[0]?.plain_text ||
      r?.title?.[0]?.plain_text ||
      '(untitled)';
    return { id: r.id, title, url: r.url, type: r.object };
  });
}

/** Fetch a page's plain-text blocks (shallow) — used when the agent needs page content. */
export async function notionGetPageText(accountId: string, pageId: string, max = 40): Promise<string> {
  const token = await resolveNotionToken(accountId);
  if (!token) throw new Error('Notion is not connected.');
  const json = await notion(`blocks/${pageId}/children?page_size=${max}`, token);
  const lines: string[] = [];
  for (const b of json.results || []) {
    const rich = b?.[b.type]?.rich_text;
    if (Array.isArray(rich)) lines.push(rich.map((t: any) => t.plain_text).join(''));
  }
  return lines.filter(Boolean).join('\n');
}
