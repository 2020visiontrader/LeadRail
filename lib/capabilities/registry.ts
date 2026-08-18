import { isSensitive, type Capability } from './types';
import { VENTURE_CAPABILITIES } from './ventures';
import { CAMPAIGN_CAPABILITIES } from './campaigns';
import { LEAD_CAPABILITIES } from './leads';
import { OUTREACH_CAPABILITIES } from './outreach';
import { CRM_CAPABILITIES } from './crm';
import { KNOWLEDGE_CAPABILITIES } from './knowledge';
import { CREATIVE_CAPABILITIES } from './creative';
import { MEMORY_CAPABILITIES } from './memory';
import { SOCIAL_CAPABILITIES } from './social';
import { SOCIAL_AUTOMATION_CAPABILITIES } from './social-automations';
import { DEAL_CAPABILITIES } from './deals';
import { SEGMENT_CAPABILITIES } from './segments';
import { JOURNEY_CAPABILITIES } from './journeys';
import { COMPANY_CAPABILITIES } from './companies';
import { ANALYTICS_CAPABILITIES } from './analytics';
import { FORM_CAPABILITIES } from './forms';
import { BUDGET_CAPABILITIES } from './budgets';
// Packet D2: SCHEDULED_CAPABILITIES is now registered. lib/scheduled/store.ts
// used to import runAgent from lib/agent/loop.ts at module top level, closing a
// cycle back through lib/agent/tools.ts into THIS file — CAPABILITIES came back
// undefined when the graph was re-evaluated (reproduced under vitest's
// resetModules + dynamic import, see tests/parity.test.ts). That import is now
// lazy, inside the function that actually runs an agent, so the cycle no longer
// resolves at module-load time.
import { SCHEDULED_CAPABILITIES } from './scheduled';
import { TEMPLATE_CAPABILITIES } from './templates';
import { SEARCH_CAPABILITIES } from './search';
import { SUPPRESSION_CAPABILITIES } from './suppressions';
import { INBOX_CAPABILITIES } from './inbox';
import { METRICS_BY_NAME } from './metrics-port';

// Two-stage tool catalog (Packet 10.3). Opt-IN, never opt-out: staging changes
// what the routing pass sees, and routing regressions are expensive. With the
// flag unset the registry holds EXACTLY the capabilities that shipped before
// this packet, so toolCatalogForPrompt() and the assembled system prompt are
// byte-identical to today. Flip the default only after measuring routing
// quality flag-on vs flag-off.
export const AGENT_STAGED_CATALOG = process.env.AGENT_STAGED_CATALOG === '1';

// Capabilities that exist only to drive the staged catalog. They are registered
// (and therefore reach the prompt, MCP tools/list and runTool) only when staging
// is on — with staging off there is nothing to expand, so exposing them would
// just add a line to a prompt this packet promises not to touch.
const STAGED_ONLY: string[] = ['describeTools'];

const ALL: Capability[] = [
  ...VENTURE_CAPABILITIES,
  ...CAMPAIGN_CAPABILITIES,
  ...LEAD_CAPABILITIES,
  ...OUTREACH_CAPABILITIES,
  ...CRM_CAPABILITIES,
  ...KNOWLEDGE_CAPABILITIES,
  ...CREATIVE_CAPABILITIES,
  ...MEMORY_CAPABILITIES,
  ...SOCIAL_CAPABILITIES,
  ...SOCIAL_AUTOMATION_CAPABILITIES,
  ...DEAL_CAPABILITIES,
  ...SEGMENT_CAPABILITIES,
  ...JOURNEY_CAPABILITIES,
  ...COMPANY_CAPABILITIES,
  ...ANALYTICS_CAPABILITIES,
  ...FORM_CAPABILITIES,
  ...BUDGET_CAPABILITIES,
  ...SCHEDULED_CAPABILITIES,
  ...TEMPLATE_CAPABILITIES,
  ...SEARCH_CAPABILITIES,
  ...SUPPRESSION_CAPABILITIES,
  ...INBOX_CAPABILITIES,
].filter((c) => AGENT_STAGED_CATALOG || !STAGED_ONLY.includes(c.name));

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
  // --- appended by Packet 1.1 (durable memory). Appended, never sorted: the
  // 37 names above must keep their exact order or the prompt catalog changes.
  'rememberFact', 'forgetFact', 'listFacts',
  // --- appended by Packet 2.2-S (social). Appended after 1.1's three, never
  // sorted: every name above must keep its exact order or the prompt catalog
  // the model routes against changes.
  'listSocialAccounts', 'getSocialStatus', 'listSocialComments', 'getSocialInsights',
  'draftSocialPost', 'publishSocialPost', 'replyToSocialComment', 'hideSocialComment',
  'deleteSocialComment', 'sendSocialMessage', 'scheduleSocialPost',
  'listScheduledSocialPosts', 'getAdBreakdown', 'setAdStatus',
  'listSocialAutomations', 'createSocialAutomation', 'enableSocialAutomation',
  'disableSocialAutomation', 'deleteSocialAutomation',
  'pauseAllSocialAutomations', 'resumeAllSocialAutomations',
  // --- appended by Packet 10.3 (two-stage catalog). Appended, never sorted.
  // Present only when staging is on, matching the ALL filter above; the
  // missing/unknown checks below still hold in both modes.
  ...(AGENT_STAGED_CATALOG ? STAGED_ONLY : []),
  // --- appended by Packet 2.2 (domain backfill). Appended, never sorted —
  // every name above (including the staged-only entry) keeps its exact
  // order. Grouped by the new domain file, in the order those files were
  // added; see each capabilities/<domain>.ts for what was left out and why.
  'listDeals', 'getDeal', 'updateDeal', 'deleteDeal', 'listActivities', 'logActivity',
  'listSegments', 'previewSegment', 'createSegment', 'updateSegment',
  'listJourneys', 'getJourney', 'createJourney', 'pauseJourney',
  'listCompanies', 'getCompany', 'createCompany', 'linkContactToCompany',
  'getOverview',
  'listForms', 'getForm', 'listSubmissions', 'createForm',
  'getBudget', 'getBudgetStatus', 'setBudget',
  'listIcpProfiles', 'updateIcpProfile',
  'globalSearch',
  'addSuppression',
  'getThread', 'replyToThread', 'markRead',
  // --- appended by Packet D1 (getCampaignAnalytics tenant-scope fix). ---
  'getCampaignAnalytics',
  // --- appended by Packet D2 (scheduled tasks, unblocked once the circular
  // import was broken). Appended, never sorted: every name above keeps its
  // exact order, because toolCatalogForPrompt() must stay byte-stable.
  'listScheduledTasks', 'createScheduledTask', 'disableScheduledTask',
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

// --- Two-stage catalog rendering (Packet 10.3) -------------------------------
// Stage 1 (stagedCatalogText): every domain, names only — what the routing pass
// sees on every hop. Stage 2 (describeDomain): full signatures for exactly one
// domain, fetched on demand by the describeTools capability.
//
// The `[needs approval]` marker is carried through BOTH stages. It is a safety
// property, not formatting: without it the model plans around a gate it cannot
// see and proposes sensitive actions believing they run immediately.

/** `name(a, b?)` plus the approval marker — the left half of a catalog line. */
function signatureOf(c: Capability): string {
  const args = Object.keys(c.inputSchema.properties || {});
  const req = new Set<string>(c.inputSchema.required || []);
  const sig = args.map((a) => (req.has(a) ? a : `${a}?`)).join(', ') || '—';
  return `${c.name}(${sig})${isSensitive(c) ? ' [needs approval]' : ''}`;
}

/** Full catalog line, identical in shape to toolCatalogForPrompt()'s. */
function fullLineOf(c: Capability): string {
  return `${signatureOf(c)} — ${c.description}`;
}

/** Domains actually present in the registry, in catalog order (first appearance).
 *  DERIVED, never hardcoded — a new domain file (or packet 5.1) shows up here on
 *  its own instead of silently missing from the staged catalog. */
export function capabilityDomains(): string[] {
  const seen: string[] = [];
  for (const c of CAPABILITIES) if (!seen.includes(c.domain)) seen.push(c.domain);
  return seen;
}

/** Stage 1 — one line per domain, capability NAMES only (no arg signatures, no
 *  descriptions), with the approval marker preserved per name. */
export function stagedCatalogText(): string {
  return capabilityDomains().map((d) => {
    const caps = CAPABILITIES.filter((c) => c.domain === d);
    const names = caps
      .map((c) => `${c.name}${isSensitive(c) ? ' [needs approval]' : ''}`)
      .join(', ');
    return `${d} (${caps.length}): ${names}`;
  }).join('\n');
}

/** Stage 2 — full signatures + descriptions for exactly ONE domain.
 *  Static registry data only: no account scope, no per-account input, nothing
 *  that could enumerate another account's anything.
 *  Throws (never returns empty) on an unknown domain, so the model gets a clean,
 *  actionable error listing the domains that do exist. */
export function describeDomain(domain: string): { domain: string; count: number; tools: string[] } {
  const known = capabilityDomains();
  const key = String(domain ?? '').trim();
  const match = known.find((d) => d.toLowerCase() === key.toLowerCase());
  if (!match) {
    throw new Error(`Unknown tool domain "${key}". Known domains: ${known.join(', ')}.`);
  }
  const tools = CAPABILITIES.filter((c) => c.domain === match).map(fullLineOf);
  return { domain: match, count: tools.length, tools };
}
