// Buffer MCP wrapper — calls the Buffer MCP JSON-RPC endpoint.
// BUFFER_API_KEY must be set in environment.

const ENDPOINT = 'https://mcp.buffer.com/mcp';

async function rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const apiKey = process.env.BUFFER_API_KEY;
  if (!apiKey) throw new Error('BUFFER_API_KEY not set');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
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

export async function getChannels(orgId?: string) {
  const result = await rpc('list_channels', orgId ? { organization_id: orgId } : {});
  return extractText(result);
}

export async function getChannel(channelId: string) {
  const result = await rpc('get_channel', { channel_id: channelId });
  return extractText(result);
}

export async function listPosts(orgId: string, status?: string, limit = 20) {
  const result = await rpc('list_posts', {
    organization_id: orgId,
    ...(status ? { status } : {}),
    limit,
  });
  return extractText(result);
}

export async function getPost(postId: string) {
  const result = await rpc('get_post', { post_id: postId });
  return extractText(result);
}

export async function createPost(channelId: string, text: string, dueAt?: string, draft = false) {
  const result = await rpc('create_post', {
    channel_id: channelId,
    text,
    ...(dueAt ? { due_at: dueAt } : {}),
    draft,
  });
  return extractText(result);
}

export async function editPost(postId: string, text: string, dueAt?: string) {
  const result = await rpc('edit_post', {
    post_id: postId,
    text,
    ...(dueAt ? { due_at: dueAt } : {}),
  });
  return extractText(result);
}

export async function deletePost(postId: string) {
  const result = await rpc('delete_post', { post_id: postId });
  return extractText(result);
}
