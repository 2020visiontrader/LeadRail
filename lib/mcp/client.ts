// Minimal MCP JSON-RPC 2.0 client — the inverse of app/api/mcp/route.ts
// (where LeadRail IS an MCP server). This lets LeadRail act as a CLIENT that
// connects to an external MCP server an account has registered
// (app/api/mcp-clients/*), to discover what tools it offers.
//
// Pure transport only: no dependencies (fetch only), no retries, no wiring
// into the agent loop. Registry/discovery in this task; consuming the tools
// from the agent loop is a later task.
//
// ANTI-HANG: every network call here carries a hard 8s timeout via
// AbortController and is wrapped in try/catch — this must never block a
// request indefinitely, no matter how the remote server behaves.

const HANDSHAKE_TIMEOUT_MS = 8_000;

export interface McpToolSummary {
  name: string;
  description?: string;
}

export interface McpConnectResult {
  ok: boolean;
  tools?: McpToolSummary[];
  error?: string;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: any;
  error?: { code: number; message: string };
}

/** POST one JSON-RPC 2.0 request with a hard timeout. Never throws — callers
 * get { ok:false, error } instead, so a single bad hop can't hang or crash
 * the caller. */
async function rpcCall(
  url: string,
  authHeader: string | null | undefined,
  method: string,
  params: Record<string, any> | undefined,
  timeoutMs: number,
): Promise<{ ok: true; result: any } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (authHeader) headers.Authorization = authHeader;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? {} }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      return { ok: false, error: `HTTP ${res.status}${detail ? `: ${detail}` : ''}` };
    }

    const contentType = res.headers.get('content-type') || '';
    let body: JsonRpcResponse;
    if (contentType.includes('text/event-stream')) {
      // Some MCP servers respond to a plain POST with an SSE-framed body even
      // outside a long-lived SSE session. Parse the first `data:` line's JSON.
      const text = await res.text();
      const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) return { ok: false, error: 'Empty SSE response' };
      body = JSON.parse(dataLine.slice(5).trim());
    } else {
      body = await res.json();
    }

    if (body.error) return { ok: false, error: body.error.message || `RPC error ${body.error.code}` };
    return { ok: true, result: body.result };
  } catch (e: any) {
    if (e?.name === 'AbortError') return { ok: false, error: `Timed out after ${timeoutMs}ms` };
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Connect to an external MCP server: perform `initialize` then `tools/list`,
 * bounded by an 8s hard timeout per call. Used by the "Test" action in the
 * MCP client registry UI (app/api/mcp-clients/[id]/test). Pure and bounded —
 * safe to call from any request path.
 */
export async function connect(url: string, authHeader?: string | null): Promise<McpConnectResult> {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'A valid http(s) URL is required' };
  }

  const init = await rpcCall(
    url,
    authHeader,
    'initialize',
    {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'leadrail-mcp-client', version: '0.1.0' },
    },
    HANDSHAKE_TIMEOUT_MS,
  );
  if (!init.ok) return { ok: false, error: `initialize failed: ${init.error}` };

  const list = await rpcCall(url, authHeader, 'tools/list', {}, HANDSHAKE_TIMEOUT_MS);
  if (!list.ok) return { ok: false, error: `tools/list failed: ${list.error}` };

  const rawTools = Array.isArray(list.result?.tools) ? list.result.tools : [];
  const tools: McpToolSummary[] = rawTools
    .filter((t: any) => t && typeof t.name === 'string')
    .map((t: any) => ({ name: t.name, description: typeof t.description === 'string' ? t.description : undefined }));

  return { ok: true, tools };
}
