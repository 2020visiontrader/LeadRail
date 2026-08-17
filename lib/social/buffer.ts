// Buffer MCP wrapper — calls the Buffer MCP JSON-RPC endpoint.
//
// PACKET 7.2. Every function here takes the caller's authenticated accountId
// FIRST and authenticates with THAT account's own credential, resolved from its
// integration_connections row (lib/social/credentials.ts). Previously this file
// read BUFFER_API_KEY from process.env, which meant `getChannels()` returned
// the operator's channels to every tenant on the deployment — the leak that
// forced Packet 2.2-S to refuse Buffer to the agent entirely.
//
// There is deliberately no un-scoped variant of `rpc`: an accountId is the only
// way to obtain a token, so a future caller cannot accidentally reintroduce a
// shared credential. The token is used for one outbound header and never
// logged, returned, or included in an error message — note that the HTTP error
// path below quotes Buffer's response body, never our request.

import { requireSocialCredential } from './credentials';

const ENDPOINT = 'https://mcp.buffer.com/mcp';

async function rpc(
  accountId: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const { token } = await requireSocialCredential(accountId, 'buffer');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method: 'tools/call',
      params: { name: method, arguments: params },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Buffer HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  return res.json();
}

function extractText(result: unknown): any {
  const content = (result as any)?.result?.content;
  if (!Array.isArray(content)) return result;
  for (const item of content) {
    if (item.type === 'text') {
      try { return JSON.parse(item.text); } catch { return item.text; }
    }
  }
  return result;
}

export async function getChannels(accountId: string, orgId?: string) {
  const result = await rpc(accountId, 'list_channels', orgId ? { organization_id: orgId } : {});
  return extractText(result);
}

export async function getChannel(accountId: string, channelId: string) {
  const result = await rpc(accountId, 'get_channel', { channel_id: channelId });
  return extractText(result);
}

export async function listPosts(accountId: string, orgId: string, status?: string, limit = 20) {
  const result = await rpc(accountId, 'list_posts', {
    organization_id: orgId,
    ...(status ? { status } : {}),
    limit,
  });
  return extractText(result);
}

export async function getPost(accountId: string, postId: string) {
  const result = await rpc(accountId, 'get_post', { post_id: postId });
  return extractText(result);
}

export async function createPost(
  accountId: string,
  channelId: string,
  text: string,
  dueAt?: string,
  draft = false,
) {
  const result = await rpc(accountId, 'create_post', {
    channel_id: channelId,
    text,
    ...(dueAt ? { due_at: dueAt } : {}),
    draft,
  });
  return extractText(result);
}

export async function editPost(accountId: string, postId: string, text: string, dueAt?: string) {
  const result = await rpc(accountId, 'edit_post', {
    post_id: postId,
    text,
    ...(dueAt ? { due_at: dueAt } : {}),
  });
  return extractText(result);
}

export async function deletePost(accountId: string, postId: string) {
  const result = await rpc(accountId, 'delete_post', { post_id: postId });
  return extractText(result);
}
