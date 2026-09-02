// Integration status for the account's Settings view (GET /api/social). This is
// browser-facing, so it returns BOOLEANS AND LABELS ONLY — never a token, a
// secret_ref, or a connection row.
//
// Packet 7.2: Buffer and GoHighLevel used to report `connected` from
// process.env, i.e. every tenant was told the operator's credential was theirs,
// and the capability then failed confusingly. They now report whether THIS
// account can actually authenticate.

import { hasSocialCredential } from './credentials';
import { resolveTokensForRow } from './connection-token';

interface IntegrationStatus {
  provider: 'meta' | 'buffer' | 'ghl';
  connected: boolean;
  label: string;
  capabilities: string[];
  error?: string;
}

export async function getIntegrations(accountId?: string): Promise<IntegrationStatus[]> {
  const integrations: IntegrationStatus[] = [];

  // Meta
  const metaConfigured = !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
  let metaConnected = !!process.env.META_ACCESS_TOKEN;
  if (accountId) {
    try {
      const { getConnections } = await import('@/lib/db');
      const conns = await getConnections(accountId);
      const candidates = conns.filter(
        (c: any) => ['facebook', 'instagram', 'meta'].includes(c.provider) && c.status === 'connected',
      );
      let found = false;
      for (const c of candidates) {
        const { accessToken } = await resolveTokensForRow(c);
        if (accessToken) { found = true; break; }
      }
      metaConnected = found;
    } catch {}
  }
  integrations.push({
    provider: 'meta',
    connected: metaConfigured && metaConnected,
    label: 'Facebook & Instagram',
    capabilities: metaConnected
      ? ['publish', 'schedule', 'comments', 'insights']
      : ['requires connection'],
  });

  // Buffer / GoHighLevel — per-account credentials (Packet 7.2). With no
  // accountId there is nothing to resolve against, so they report disconnected
  // rather than reporting a shared env credential as if it were the caller's.
  const bufferConnected = accountId ? await hasSocialCredential(accountId, 'buffer') : false;
  integrations.push({
    provider: 'buffer',
    connected: bufferConnected,
    label: 'Buffer (Cross-Platform)',
    capabilities: bufferConnected
      ? ['publish', 'schedule', 'analytics', 'LinkedIn', 'Twitter/X', 'Facebook', 'Instagram']
      : ['requires connection'],
  });

  const ghlConnected = accountId ? await hasSocialCredential(accountId, 'ghl') : false;
  integrations.push({
    provider: 'ghl',
    connected: ghlConnected,
    label: 'GoHighLevel CRM',
    capabilities: ghlConnected
      ? ['publish', 'schedule', 'analytics', 'Facebook', 'Instagram', 'LinkedIn', 'Google Business']
      : ['requires connection'],
  });

  return integrations;
}
