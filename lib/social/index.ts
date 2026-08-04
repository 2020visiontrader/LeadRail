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
      const meta = conns.find(
        (c: any) => ['facebook', 'instagram', 'meta'].includes(c.provider) && c.status === 'connected' && !!c.meta?.access_token,
      );
      metaConnected = !!meta;
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

  // Buffer
  const bufferConnected = !!process.env.BUFFER_API_KEY;
  integrations.push({
    provider: 'buffer',
    connected: bufferConnected,
    label: 'Buffer (Cross-Platform)',
    capabilities: bufferConnected
      ? ['publish', 'schedule', 'analytics', 'LinkedIn', 'Twitter/X', 'Facebook', 'Instagram']
      : ['requires BUFFER_API_KEY'],
  });

  // GoHighLevel
  const ghlConnected = !!process.env.GOHIGHLEVEL_ACCESS_TOKEN;
  integrations.push({
    provider: 'ghl',
    connected: ghlConnected,
    label: 'GoHighLevel CRM',
    capabilities: ghlConnected
      ? ['publish', 'schedule', 'analytics', 'Facebook', 'Instagram', 'LinkedIn', 'Google Business']
      : ['requires GHL connection'],
  });

  return integrations;
}
