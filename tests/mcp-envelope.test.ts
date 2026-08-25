// The MCP result envelope, and the two bugs that lived in it.
//
// 1. `isError: true` arrives inside a perfectly successful JSON-RPC response.
//    Ignoring it recorded a REJECTED tool call as a completed one, with a green
//    tick in the trace — the same class of bug as a pending approval reading as
//    a finished action, and it is the one worth a permanent test.
//
// 2. The envelope was returned verbatim, so an observation read
//    `{"content":[{"type":"text",...}]}`. The model had to parse JSON to find
//    the answer and the user was shown the JSON.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { callTool, connect } from '../lib/mcp/client';

function mockRpc(result: any) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )));
}

afterEach(() => vi.unstubAllGlobals());

describe('tool call results', () => {
  it('reports isError as a failure, not a success', async () => {
    mockRpc({ isError: true, content: [{ type: 'text', text: 'Invalid arguments for tool models_explore' }] });
    const r = await callTool('https://x.test/mcp', null, 'models_explore', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid arguments/i);
  });

  it('unwraps text content instead of handing back the envelope', async () => {
    mockRpc({ content: [{ type: 'text', text: 'four models available' }] });
    const r = await callTool('https://x.test/mcp', null, 'models_explore', {});
    expect(r.ok).toBe(true);
    expect(r.result).toBe('four models available');
  });

  it('prefers structured output when the server provides it', async () => {
    mockRpc({ content: [{ type: 'text', text: 'ignored' }], structuredContent: { models: ['a'] } });
    const r = await callTool('https://x.test/mcp', null, 't', {});
    expect(r.result).toEqual({ models: ['a'] });
  });

  it('names non-text parts rather than silently dropping them', async () => {
    mockRpc({ content: [{ type: 'image', data: '...' }, { type: 'text', text: 'caption' }] });
    const r = await callTool('https://x.test/mcp', null, 't', {});
    expect(r.result).toContain('[image]');
    expect(r.result).toContain('caption');
  });
});

describe('discovery', () => {
  it('keeps each tool\'s argument schema — without it the model must guess', async () => {
    const schema = { type: 'object', properties: { action: { enum: ['list', 'search'] } } };
    vi.stubGlobal('fetch', vi.fn(async (_u: any, init: any) => {
      const method = JSON.parse(init.body).method;
      const result = method === 'initialize'
        ? { protocolVersion: '2025-06-18', serverInfo: { name: 'test' } }
        : { tools: [{ name: 'models_explore', description: 'd', inputSchema: schema }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const r = await connect('https://x.test/mcp', null);
    expect(r.ok).toBe(true);
    expect(r.tools?.[0].inputSchema).toEqual(schema);
    expect(r.diagnostics?.toolsWithSchema).toBe(1);
    expect(r.warnings).toHaveLength(0);
  });

  it('warns when tools publish no schema, but still reports the connection as working', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: any, init: any) => {
      const method = JSON.parse(init.body).method;
      const result = method === 'initialize'
        ? { protocolVersion: '2025-06-18' }
        : { tools: [{ name: 'bare', description: 'd' }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const r = await connect('https://x.test/mcp', null);
    // Working, but unusable in a specific way — those must not be the same verdict.
    expect(r.ok).toBe(true);
    expect(r.diagnostics?.toolsWithSchema).toBe(0);
    expect(r.warnings?.join(' ')).toMatch(/no argument schema/i);
  });
});
