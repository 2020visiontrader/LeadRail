// lib/capabilities/external-mcp.ts — Packet 4: bridge external MCP clients
// into the agent.
//
// lib/mcp/client.ts can already connect to an external MCP server. lib/mcp/
// clients.ts already has full encrypted CRUD for an account's registered
// servers. Neither is wired into the agent's tool catalog — a connected
// server's tools were discoverable in Settings but invisible to the
// assistant. This file is that bridge: it turns an account's connected,
// enabled MCP clients into ordinary Capability entries the agent loop can
// route to and runTool() can execute, so they get the exact SAME gates as
// every first-party capability (0.1 approval, 1.4 spend where applicable).
//
// Non-negotiables (COPILOT_REMEDIATION_PLAN.md Phase 4 + delegation/README):
//  - conservative by default: gate:'external_send' (approval required) unless
//    the operator explicitly opted a client into allow_auto (migration 044).
//    A third party's side effects are unknown; the account owner, not us,
//    decides when that's acceptable for a SPECIFIC server.
//  - never a synchronous network call in the hot path: this reads the cached
//    `discovered_tools` snapshot (populated by the existing
//    POST /api/mcp-clients/:id/test flow) and kicks off a fire-and-forget
//    background refresh when stale. A slow or dead third-party server can
//    never stall a turn.
//  - failure isolation: a capability's `run` throws a plain Error on any
//    transport failure. runTool() already wraps every capability's run() in
//    try/catch and turns that into { ok:false, error }, which the loop
//    renders as a normal `ERROR: …` observation — no special-casing needed
//    here, and a broken client degrades one tool call, never the whole turn.
//  - namespaced ext_<clientSlug>_<toolName> so an external tool can never
//    collide with a first-party capability name (Capability.name is bound to
//    forever by MCP clients per lib/capabilities/types.ts's own contract).

import { z } from 'zod';
import { supabase } from '@/lib/db';
import { connect, callTool } from '@/lib/mcp/client';
import { decryptMcpAuthHeader, recordMcpTestResult } from '@/lib/mcp/clients';
import type { Capability } from './types';

const CACHE_FRESH_MS = 15 * 60 * 1000; // 15 minutes — matches the plan's "refresh lazily" window
const MAX_EXTERNAL_TOOLS_PER_ACCOUNT = 25; // catalog-bloat cap (Phase 4 step 4)

function slug(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'x';
}

interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

interface ExternalClientRow {
  id: string;
  name: string;
  enabled: boolean;
  allow_auto: boolean;
  discovered_tools: DiscoveredTool[] | null;
  last_checked_at: string | null;
}

/** Reconnect to the remote server and persist the refreshed tool list.
 *  Fire-and-forget ONLY — never awaited by loadExternalCapabilities, so a
 *  stale or unreachable server can never add latency to an agent turn. Any
 *  failure here just leaves the existing cache in place until the next call. */
function refreshInBackground(accountId: string, clientId: string): void {
  void (async () => {
    try {
      const resolved = await decryptMcpAuthHeader(accountId, clientId);
      if (!resolved) return;
      const result = await connect(resolved.url, resolved.authHeader);
      await recordMcpTestResult(accountId, clientId, result);
    } catch {
      // Best-effort telemetry refresh, not a gate — see file header.
    }
  })();
}

/**
 * Account-scoped: every enabled, connected MCP client's cached tools, mapped
 * to Capability. Pure DB read + in-memory mapping — no network call on this
 * path (see file header). Never throws: a lookup failure yields no external
 * capabilities rather than breaking the caller's turn.
 */
export async function loadExternalCapabilities(accountId: string): Promise<Capability[]> {
  const { data, error } = await supabase
    .from('mcp_clients')
    .select('id, name, enabled, allow_auto, discovered_tools, last_checked_at')
    .eq('account_id', accountId)
    .eq('enabled', true);
  if (error || !data) return [];

  const caps: Capability[] = [];
  outer: for (const row of data as ExternalClientRow[]) {
    const stale = !row.last_checked_at || Date.now() - new Date(row.last_checked_at).getTime() > CACHE_FRESH_MS;
    if (stale) refreshInBackground(accountId, row.id); // never awaited

    const clientId = row.id;
    const clientName = row.name;
    const clientSlug = slug(clientName);
    for (const t of row.discovered_tools || []) {
      if (!t?.name) continue;
      caps.push({
        name: `ext_${clientSlug}_${slug(t.name)}`,
        domain: 'external',
        title: `${clientName}: ${t.name}`,
        description: t.description
          ? `[External — ${clientName}] ${t.description}`
          : `[External — ${clientName}] tool "${t.name}" on a connected MCP server.`,
        // Conservative by default — see file header. Only an explicit,
        // per-client operator opt-in (allow_auto) downgrades this off the
        // sensitive gates; every other client stays approval-required.
        gate: row.allow_auto ? 'internal_write' : 'external_send',
        // The remote server's OWN schema, when it published one. Previously
        // this was always an empty object, which meant the model saw a tool
        // with no parameters and had to invent them — the direct cause of
        // "Invalid arguments" failures that looked like broken connections.
        // Falls back to the permissive shape only when a server publishes
        // nothing, since the model still needs some shape to fill in.
        inputSchema: (t.inputSchema && typeof t.inputSchema === 'object' && t.inputSchema.type)
          ? t.inputSchema
          : { type: 'object', properties: {}, additionalProperties: true },
        zod: z.record(z.string(), z.any()).optional().default({}),
        run: async (callAccountId: string, args: any) => {
          // Re-scope by the account_id actually passed at call time, not a
          // closed-over value — belt-and-braces per the "every DB query
          // filters by account_id in the query" rule, in case this Capability
          // is ever held across a call boundary.
          const resolved = await decryptMcpAuthHeader(callAccountId, clientId);
          if (!resolved) throw new Error(`${clientName} is no longer connected.`);
          const res = await callTool(resolved.url, resolved.authHeader, t.name, args ?? {});
          if (!res.ok) throw new Error(`${clientName} is unavailable: ${res.error}`);
          return res.result;
        },
      });
      if (caps.length >= MAX_EXTERNAL_TOOLS_PER_ACCOUNT) break outer;
    }
  }
  return caps.slice(0, MAX_EXTERNAL_TOOLS_PER_ACCOUNT);
}
