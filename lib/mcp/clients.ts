// CRUD for the account-scoped external-MCP-server registry (migration
// 026_mcp_clients.sql). Mirrors the CRUD shape in lib/ai/providers.ts:
// account_id is always server-derived, auth_header is encrypted at rest via
// the same vault (lib/ai/crypto.ts) and never returned decrypted to a client.

import { supabase } from '@/lib/db';
import { decryptSecret, encryptSecret, vaultConfigured } from '@/lib/ai/crypto';

export type McpTransport = 'http' | 'sse';

export interface McpClientRow {
  id: string;
  account_id: string;
  name: string;
  transport: McpTransport;
  url: string;
  auth_header_encrypted: string | null;
  enabled: boolean;
  // Packet 4 / migration 044: operator opt-in that lets this client's tools
  // run WITHOUT an approval card. Defaults false — a newly connected server's
  // tools are approval-required (gate:'external_send') until the operator
  // explicitly flips this. See lib/capabilities/external-mcp.ts.
  allow_auto: boolean;
  last_status: string | null;
  last_checked_at: string | null;
  discovered_tools: { name: string; description?: string }[];
  created_at: string;
  updated_at: string;
}

export type SafeMcpClient = Omit<McpClientRow, 'auth_header_encrypted'> & { has_auth_header: boolean };

function toSafe(row: McpClientRow): SafeMcpClient {
  const { auth_header_encrypted, ...rest } = row;
  return { ...rest, has_auth_header: Boolean(auth_header_encrypted) };
}

export async function listMcpClients(accountId: string): Promise<SafeMcpClient[]> {
  const { data, error } = await supabase
    .from('mcp_clients')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(toSafe);
}

export async function getMcpClient(accountId: string, id: string): Promise<SafeMcpClient | null> {
  const { data, error } = await supabase
    .from('mcp_clients')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return data ? toSafe(data) : null;
}

/** Internal-only fetch that includes the encrypted auth header, for the test
 * connection flow. Never expose this row directly over the API. */
async function getMcpClientRaw(accountId: string, id: string): Promise<McpClientRow | null> {
  const { data, error } = await supabase
    .from('mcp_clients')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function createMcpClient(accountId: string, input: {
  name: string; transport: McpTransport; url: string; auth_header?: string | null; enabled?: boolean; allow_auto?: boolean;
}): Promise<SafeMcpClient> {
  const row: Record<string, any> = {
    account_id: accountId,
    name: input.name,
    transport: input.transport,
    url: input.url,
    enabled: input.enabled ?? true,
    // Conservative default — see the allow_auto comment on McpClientRow above.
    allow_auto: input.allow_auto === true,
  };
  if (input.auth_header) {
    if (!vaultConfigured()) {
      const err: any = new Error('AI_VAULT_KEY is not set on this deployment; cannot store an auth header');
      err.code = 'vault_not_configured';
      throw err;
    }
    row.auth_header_encrypted = encryptSecret(input.auth_header);
  }
  const { data, error } = await supabase.from('mcp_clients').insert([row]).select().single();
  if (error) throw error;
  return toSafe(data);
}

export async function updateMcpClient(accountId: string, id: string, patch: {
  name?: string; transport?: McpTransport; url?: string; auth_header?: string | null; enabled?: boolean; allow_auto?: boolean;
}): Promise<SafeMcpClient> {
  const row: Record<string, any> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.transport !== undefined) row.transport = patch.transport;
  if (patch.url !== undefined) row.url = patch.url;
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  if (patch.allow_auto !== undefined) row.allow_auto = patch.allow_auto;
  if (patch.auth_header) {
    if (!vaultConfigured()) {
      const err: any = new Error('AI_VAULT_KEY is not set on this deployment; cannot store an auth header');
      err.code = 'vault_not_configured';
      throw err;
    }
    row.auth_header_encrypted = encryptSecret(patch.auth_header);
  }
  const { data, error } = await supabase
    .from('mcp_clients')
    .update(row)
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .single();
  if (error) throw error;
  if (!data) throw new Error('mcp client not found');
  return toSafe(data);
}

export async function deleteMcpClient(accountId: string, id: string): Promise<{ id: string; deleted: true }> {
  const { data, error } = await supabase
    .from('mcp_clients')
    .delete()
    .eq('id', id)
    .eq('account_id', accountId)
    .select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('mcp client not found');
  return { id, deleted: true };
}

export async function recordMcpTestResult(accountId: string, id: string, result: {
  ok: boolean; tools?: { name: string; description?: string }[]; error?: string;
}): Promise<SafeMcpClient> {
  const row = {
    last_status: result.ok ? 'ok' : 'error',
    last_checked_at: new Date().toISOString(),
    discovered_tools: result.ok ? (result.tools || []) : [],
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('mcp_clients')
    .update(row)
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .single();
  if (error) throw error;
  if (!data) throw new Error('mcp client not found');
  return toSafe(data);
}

/** Decrypt the stored auth header for exactly one outbound test call. Never
 * logged, never returned to a client — see lib/ai/crypto.ts. */
export async function decryptMcpAuthHeader(accountId: string, id: string): Promise<{ url: string; authHeader: string | null } | null> {
  const raw = await getMcpClientRaw(accountId, id);
  if (!raw) return null;
  const authHeader = raw.auth_header_encrypted ? decryptSecret(raw.auth_header_encrypted) : null;
  return { url: raw.url, authHeader };
}
