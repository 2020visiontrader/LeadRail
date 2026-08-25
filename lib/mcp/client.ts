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
// Packet 4: a tool call can legitimately take longer than a handshake (the
// remote server is doing real work), so it gets its own, longer hard timeout.
// Still bounded — this must never be able to hang a turn indefinitely.
const CALL_TIMEOUT_MS = 20_000;

export interface McpToolSummary {
  name: string;
  description?: string;
  /** The remote tool's own JSON Schema, carried through verbatim.
   *
   *  THIS WAS BEING DISCARDED, and discarding it is why calls failed with
   *  "invalid arguments": the model was shown a tool with a name, a sentence of
   *  description, and NO parameters, so it had to invent argument names and
   *  guess enum values. The server then rejected the guess — correctly — and
   *  the whole thing read as a broken connection rather than as us withholding
   *  the instructions. A schema with an enum in it is the difference between
   *  the model knowing `action` must be one of four strings and it picking a
   *  fifth. */
  inputSchema?: Record<string, any>;
}

/** What the connection test actually established, beyond "it answered".
 *
 *  WHY MORE THAN A BOOLEAN. The old test ran initialize + tools/list and called
 *  a success a working connection. A server can pass both of those and still
 *  leave the assistant unable to call anything — which is exactly what
 *  happened: tools were discovered, none of their schemas were kept, and every
 *  call came back "invalid arguments". A green tick that does not distinguish
 *  those two states is worse than no tick, because it sends you looking at the
 *  network when the problem is the payload. */
export interface McpDiagnostics {
  /** The protocol version the server negotiated. */
  protocolVersion?: string;
  serverName?: string;
  toolCount: number;
  /** How many of those tools published an argument schema. A tool without one
   *  forces the model to guess argument names and enum values, so this is the
   *  number that predicts whether calls will actually succeed. */
  toolsWithSchema: number;
  /** Named so the warning can point at them rather than saying "some tools". */
  toolsMissingSchema: string[];
}

export interface McpConnectResult {
  ok: boolean;
  tools?: McpToolSummary[];
  error?: string;
  diagnostics?: McpDiagnostics;
  /** Things that are true and worth knowing, but are not failures. Kept
   *  separate from `error` so a usable connection is never reported as a
   *  broken one. */
  warnings?: string[];
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
    .map((t: any) => ({
      name: t.name,
      description: typeof t.description === 'string' ? t.description : undefined,
      // Accept either spelling: the spec says inputSchema, some servers emit
      // input_schema. Neither is worth losing a schema over.
      inputSchema: (t.inputSchema && typeof t.inputSchema === 'object')
        ? t.inputSchema
        : (t.input_schema && typeof t.input_schema === 'object') ? t.input_schema : undefined,
    }));

  const missing = tools.filter((t) => !t.inputSchema?.type).map((t) => t.name);
  const warnings: string[] = [];
  if (!tools.length) {
    warnings.push('The server connected but offers no tools, so the assistant has nothing to call on it.');
  } else if (missing.length) {
    // The precise failure this test previously could not see.
    warnings.push(
      `${missing.length} of ${tools.length} tools publish no argument schema (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}). ` +
      'Calls to those may fail with "invalid arguments", because there is nothing telling the assistant what to pass.',
    );
  }

  return {
    ok: true,
    tools,
    warnings,
    diagnostics: {
      protocolVersion: typeof init.result?.protocolVersion === 'string' ? init.result.protocolVersion : undefined,
      serverName: typeof init.result?.serverInfo?.name === 'string' ? init.result.serverInfo.name : undefined,
      toolCount: tools.length,
      toolsWithSchema: tools.length - missing.length,
      toolsMissingSchema: missing,
    },
  };
}

export interface McpCallResult {
  ok: boolean;
  result?: any;
  error?: string;
}

/**
 * Call one tool on an external MCP server (Packet 4 — the bridge that lets the
 * agent actually USE a connected server's tools, not just discover them).
 *
 * Same shape as `connect()`: pure transport, hard-timeout bounded, never
 * throws — a dead or slow remote server degrades to { ok:false, error } so the
 * caller (lib/capabilities/external-mcp.ts) can turn it into a normal
 * ERROR observation instead of failing the whole agent turn.
 */
export async function callTool(
  url: string,
  authHeader: string | null | undefined,
  name: string,
  args: Record<string, any>,
): Promise<McpCallResult> {
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'A valid http(s) URL is required' };
  }
  const res = await rpcCall(url, authHeader, 'tools/call', { name, arguments: args ?? {} }, CALL_TIMEOUT_MS);
  if (!res.ok) return { ok: false, error: res.error };

  // Unwrap the MCP result envelope.
  //
  // TWO BUGS LIVED HERE. The envelope was returned verbatim, so an observation
  // read `{"content":[{"type":"text","text":"..."}]}` — the model had to parse
  // JSON to find the answer, and the trace showed that JSON to the user.
  //
  // Worse, `isError: true` is how MCP reports a TOOL failure, and it arrives
  // inside a perfectly successful JSON-RPC response. Ignoring it meant a
  // rejected call was recorded as a completed one, with a green tick — the
  // same class of bug as a pending approval reading as a finished action.
  const envelope = res.result;
  const text = extractText(envelope);
  if (envelope && typeof envelope === 'object' && envelope.isError) {
    return { ok: false, error: text || 'The tool reported an error but gave no detail.' };
  }
  // Structured output, where a server provides it, is more useful than prose.
  if (envelope && typeof envelope === 'object' && envelope.structuredContent !== undefined) {
    return { ok: true, result: envelope.structuredContent };
  }
  return { ok: true, result: text !== null ? text : envelope };
}

/** Pull readable text out of an MCP content array, or null when there is none.
 *  Non-text parts (images, resources) are named rather than dropped, so an
 *  observation never silently loses that something came back. */
function extractText(envelope: any): string | null {
  const parts = Array.isArray(envelope?.content) ? envelope.content : null;
  if (!parts) return null;
  const out: string[] = [];
  for (const p of parts) {
    if (p?.type === 'text' && typeof p.text === 'string') out.push(p.text);
    else if (p?.type === 'resource' && typeof p.resource?.text === 'string') out.push(p.resource.text);
    else if (p?.type) out.push(`[${p.type}]`);
  }
  return out.length ? out.join('\n') : null;
}
