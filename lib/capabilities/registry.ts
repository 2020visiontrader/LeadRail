import type { Capability } from './types';
import { VENTURE_CAPABILITIES } from './ventures';
import { CAMPAIGN_CAPABILITIES } from './campaigns';
import { LEAD_CAPABILITIES } from './leads';
import { OUTREACH_CAPABILITIES } from './outreach';
import { CRM_CAPABILITIES } from './crm';
import { KNOWLEDGE_CAPABILITIES } from './knowledge';
import { CREATIVE_CAPABILITIES } from './creative';
import { METRICS_BY_NAME } from './metrics-port';

const ALL: Capability[] = [
  ...VENTURE_CAPABILITIES,
  ...CAMPAIGN_CAPABILITIES,
  ...LEAD_CAPABILITIES,
  ...OUTREACH_CAPABILITIES,
  ...CRM_CAPABILITIES,
  ...KNOWLEDGE_CAPABILITIES,
  ...CREATIVE_CAPABILITIES,
];

// CATALOG ORDER — the exact key order of the original TOOLS object literal in
// lib/agent/tools.ts, which interleaved domains. toolCatalogForPrompt() renders
// in this order and the model's tool-routing accuracy is sensitive to it, so
// Packet 2.1 requires a byte-identical catalog. Grouping by domain file (the
// natural result of the split) reorders it — hence this explicit list.
// Append a new capability here; never sort this array.
const CATALOG_ORDER: string[] = [
  'listVentures', 'listAdAccounts', 'listCampaigns', 'getCampaign', 'listAdSets',
  'listAds', 'listAssets', 'getInsights', 'listLeads', 'getLead',
  'listConversations', 'createCampaign', 'importAsset', 'launchCampaign',
  'pauseCampaign', 'syncCampaign', 'analyzeCampaign', 'searchNotion',
  'searchDrive', 'readNotionPage', 'readDriveFile', 'sourceLeads', 'enrichLead',
  'draftOutreach', 'sendEmail', 'listSequences', 'enrollInSequence', 'listStages',
  'createDeal', 'moveDeal', 'addNote', 'updateLeadStatus', 'listTags', 'tagLead',
  'getPersona', 'updatePersona', 'generateAdCopy',
];

const byName = new Map(ALL.map((c) => [c.name, c]));

// Fail loudly at import time rather than silently dropping a capability: a tool
// missing from CATALOG_ORDER would vanish from the agent's prompt AND from MCP
// tools/list, which stays invisible until a user asks for it.
const missing = ALL.filter((c) => !CATALOG_ORDER.includes(c.name)).map((c) => c.name);
if (missing.length) {
  throw new Error(`Capability missing from CATALOG_ORDER: ${missing.join(', ')}`);
}
const unknown = CATALOG_ORDER.filter((n) => !byName.has(n));
if (unknown.length) {
  throw new Error(`CATALOG_ORDER lists unknown capability: ${unknown.join(', ')}`);
}

export const CAPABILITIES: Capability[] = CATALOG_ORDER.map((n) => {
  const c = byName.get(n)!;
  // Attach the ported deriveMetrics logic (Packet 2.1 step 5). Kept as a lookup
  // rather than inlined per capability so the port stays diffable against the
  // original switch in lib/agent/loop.ts. Capabilities with no entry get no
  // metrics — equivalent to the old switch's `default: return {}`.
  const m = METRICS_BY_NAME[n];
  return m ? { ...c, metrics: m } : c;
});

export const CAPABILITY_BY_NAME: Record<string, Capability> =
  Object.fromEntries(CAPABILITIES.map((c) => [c.name, c]));
