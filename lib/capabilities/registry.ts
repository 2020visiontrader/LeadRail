import { isSensitive, type Capability } from './types';
import { VENTURE_CAPABILITIES } from './ventures';
import { CAMPAIGN_CAPABILITIES } from './campaigns';
import { LEAD_CAPABILITIES } from './leads';
import { OUTREACH_CAPABILITIES } from './outreach';
import { CRM_CAPABILITIES } from './crm';
import { KNOWLEDGE_CAPABILITIES } from './knowledge';
import { CREATIVE_CAPABILITIES } from './creative';
import { STRATEGY_CAPABILITIES } from './strategy';
import { QUALITY_CAPABILITIES } from './quality';
import { GOAL_CAPABILITIES } from './goals';
import { MEMORY_CAPABILITIES } from './memory';
import { SUBJECT_MEMORY_CAPABILITIES } from './subject-memory';
import { APPROVAL_CAPABILITIES } from './approvals';
import { PLAN_CAPABILITIES } from './plans';
import { DOCUMENT_CAPABILITIES } from './documents';
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
import { PIPELINE_CAPABILITIES } from './pipeline';
import { CRM_AUTOMATION_CAPABILITIES } from './crm-automations';
import { WORKSPACE_CAPABILITIES } from './workspace';
import { CONTENT_CAPABILITIES } from './content';
import { VIDEO_CAPABILITIES } from './video';
import { DELIVERABLE_CAPABILITIES } from './deliverables';
import { DELEGATION_CAPABILITIES } from './delegation';
import { SUPPRESSION_CAPABILITIES } from './suppressions';
import { INBOX_CAPABILITIES } from './inbox';
import { DIAGNOSTICS_CAPABILITIES } from './diagnostics';
import { SKILL_LOOKUP_CAPABILITIES } from './skill-lookup';
import { METRICS_BY_NAME } from './metrics-port';

// Two-stage tool catalog (Packet 10.3, flipped 2026-09-03 — C6). The full,
// unstaged catalog (toolCatalogForPrompt) cost ~12K tokens on EVERY model
// call: 183 tools, one line each, unconditional, every step. The staged form
// (toolCatalogStaged — one line per domain, names only, ~3.8K chars vs
// ~48K) is now what ships by default; the model expands exactly one domain
// at a time on demand with the describeTools capability (verified reachable:
// describeDomain() in this file returns full signatures for every tool in a
// domain, and it's registered — see STAGED_ONLY below — whenever staging is
// on, which is now always unless overridden).
//
// AGENT_FULL_CATALOG=1 is the escape hatch that restores the exact
// pre-2026-09-03 behaviour (full catalog, no describeTools) — set it to roll
// back without a deploy if staged routing quality regresses. The flag is
// inverted, not deleted or renamed, so a rollback is a one-line env change,
// not a revert.
export const AGENT_FULL_CATALOG = process.env.AGENT_FULL_CATALOG === '1';
export const AGENT_STAGED_CATALOG = !AGENT_FULL_CATALOG;

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
  ...STRATEGY_CAPABILITIES,
  ...QUALITY_CAPABILITIES,
  ...GOAL_CAPABILITIES,
  ...MEMORY_CAPABILITIES,
  ...SUBJECT_MEMORY_CAPABILITIES,
  ...APPROVAL_CAPABILITIES,
  ...PLAN_CAPABILITIES,
  ...DOCUMENT_CAPABILITIES,
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
  ...PIPELINE_CAPABILITIES,
  ...CRM_AUTOMATION_CAPABILITIES,
  ...WORKSPACE_CAPABILITIES,
  ...CONTENT_CAPABILITIES,
  ...VIDEO_CAPABILITIES,
  ...DELIVERABLE_CAPABILITIES,
  ...DELEGATION_CAPABILITIES,
  ...SUPPRESSION_CAPABILITIES,
  ...INBOX_CAPABILITIES,
  ...DIAGNOSTICS_CAPABILITIES,
  ...SKILL_LOOKUP_CAPABILITIES,
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
  'draftOutreach', 'sendEmail', 'outreachHistory', 'listSequences', 'enrollInSequence', 'listStages',
  'createDeal', 'moveDeal', 'addNote', 'updateLeadStatus', 'listTags', 'tagLead',
  'getPersona', 'updatePersona', 'generateAdCopy', 'analyzeBrand', 'getBrandStrategy', 'reviewContent', 'judgeVoice', 'createGoal', 'listGoals', 'logGoalProgress',
  // --- appended by Packet 1.1 (durable memory). Appended, never sorted: the
  // 37 names above must keep their exact order or the prompt catalog changes.
  'rememberFact', 'forgetFact', 'listFacts',
  'declareContext', 'recallSubject', 'recallHistory', 'listObservedPatterns',
  'promoteObservation', 'demoteObservation',
  'listStandingApprovals', 'revokeStandingApproval',
  'createPlan', 'completePlanStep', 'blockPlanStep', 'getPlan', 'listPlans', 'startPlan', 'cancelPlan',
  'listDocuments', 'readDocument', 'saveDocumentToLibrary', 'removeDocumentFromLibrary',
  // --- appended by Packet 2.2-S (social). Appended after 1.1's three, never
  // sorted: every name above must keep its exact order or the prompt catalog
  // the model routes against changes.
  'listSocialAccounts', 'getSocialStatus', 'listSocialComments', 'listSocialMessages', 'getSocialInsights',
  // --- appended: page/profile READ access. Without these two nothing in the
  // catalog could produce a post id, so listSocialComments and
  // getSocialInsights (both above) were unreachable in practice — the model
  // had no way to answer "how did my last post do?".
  'listSocialPosts', 'getSocialProfile', 'researchSocialProfile',
  'draftSocialPost', 'publishSocialPost', 'replyToSocialComment', 'hideSocialComment',
  'deleteSocialComment', 'sendSocialMessage', 'scheduleSocialPost',
  'listScheduledSocialPosts', 'getAdBreakdown', 'setAdStatus',
  'listSocialAutomations', 'createSocialAutomation', 'enableSocialAutomation',
  'disableSocialAutomation', 'deleteSocialAutomation',
  'pauseAllSocialAutomations', 'resumeAllSocialAutomations',
  // --- appended: two engines that shipped without a way for the assistant to
  // reach them. The six-stage content pipeline (migration 032) and the CRM
  // automations engine (migration 012) were both live over their HTTP routes
  // and invisible to the catalog, so "run the content engine" and "set up an
  // automation" had no tool to route to.
  'runContentPipeline', 'listContentPipelineRuns', 'getContentPipelineRun',
  'listAutomations', 'createAutomation', 'enableAutomation',
  'disableAutomation', 'deleteAutomation',
  // --- appended: everyday surfaces that had a route and a UI but no tool
  // name, so the assistant answered "I can't do that" about features the
  // platform plainly has. createSequence/createTemplate in particular closed
  // the outreach loop — it could enrol into a sequence it had no way to build.
  'listNotifications', 'markNotificationsRead', 'listApprovals',
  'createVenture', 'updateVenture', 'listTemplates', 'createTemplate',
  'createSequence', 'listSkills', 'setSkillEnabled', 'generateImage',
  // --- appended: the content engine. The board and its lifecycle, the pillars
  // content rotates through, the per-platform constraints every generator must
  // obey, the character-reference system that stops a recurring avatar drifting
  // between generations, and video — which the platform had none of at all.
  'listContentItems', 'getContentBoard', 'getContentItem', 'createContentItem',
  'updateContentItem', 'setContentStatus', 'deleteContentItem',
  'generateContentPiece', 'generateBrandImage', 'listCharacterRefs',
  'createCharacterRef', 'generateBrandVideo', 'getVideoStatus',
  'startBrandIntake', 'runBrandResearch', 'listResearchFindings', 'proposeBrandCanon',
  'getBrandCanon', 'setBrandCanon', 'scoreContentLinearity',
  'listContentPillars', 'createContentPillar', 'deleteContentPillar',
  'listPlatformSpecs', 'setPlatformSpec',
  'syncContentPerformance', 'getContentPerformance', 'proposeContentLearnings',
  // --- appended: the assistant could produce a report and had no way to hand
  // it over, and could not call for a specialist once a turn had started.
  'createFile', 'listSpecialists', 'askSpecialist',
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
  // --- appended by Packet W1 (open-web search, Tavily/SerpAPI). Appended,
  // never sorted, same reason as every entry above.
  'webSearch',
  // --- appended 2026-08-19: enrichLead only looks up a person, it never
  // persisted a contacts row, so draftOutreach/sendEmail had no lead to point
  // at for anyone not already in the CRM (reproduced live: enrichLead
  // succeeded, draftOutreach then failed "Lead not found"). createLead closes
  // that gap. Appended, never sorted, same reason as every entry above.
  'createLead',
  // --- appended 2026-08-23: diagnostics domain — the first capability whose
  // `findings` hook emits structured evidence/claim/finding/verdict events
  // instead of leaving the model to narrate its result in prose. Appended,
  // never sorted, same reason as every entry above.
  'diagnosePipeline',
  // --- appended 2026-08-26: the assistant could GENERATE video and never watch
  // one. Two paths, split by who owns the footage: an uploaded file is decoded
  // in the browser and every frame read for cuts and pace, while a link to
  // someone else's published video goes to Higgsfield rather than being
  // downloaded by us. Appended, never sorted, same reason as every entry above.
  'watchVideoUrl', 'checkVideoAnalysis', 'analyseUploadedVideo',
  // --- appended 2026-09-03: C7 (skill-injection cap). skillsBlock
  // (lib/agent/loop.ts) now clips a skill's instructions past a per-skill
  // budget and points the model at this tool by slug to read the rest.
  // Appended, never sorted, same reason as every entry above.
  'describeSkill',
  // --- appended 2026-09-03: C14 (aggregate counts). A count was previously
  // answered by listing whole tables — 282K chars of rows to produce a number
  // Postgres returns in one line, and three delegates counting the same table
  // disagreed (54/56/61). These count in SQL and return a total plus optional
  // per-group counts. Appended, never sorted, same reason as every entry above.
  'countLeads', 'countDeals', 'countCompanies',
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

// Short type names for the catalog line. lib/agent/tools.ts's catalogLine and
// this module's fullLineOf are two independent renderers of the SAME line —
// exactly the failure mode CLAUDE.md calls out for runAgentImpl and
// runAgentStreamImpl (lib/agent/loop.ts): two things that must stay
// byte-identical, standing in two places. They drifted once already —
// catalogLine learned to render argument types (91b13be) while this file's
// copy stayed on the old untyped `name(a, b?)` shape, so the full catalog and
// a stage-2 domain expansion disagreed about the signature of every single
// capability. Rendering is now owned HERE, in one function
// (renderCatalogLine), and lib/agent/tools.ts's catalogLine calls it instead
// of re-implementing it — one renderer, called from both places, so there is
// nothing left to drift.
const SHORT_TYPE: Record<string, string> = {
  string: 'str',
  number: 'num',
  boolean: 'bool',
  array: 'arr',
  object: 'obj',
};

function shortType(schema: any): string {
  const t = schema?.type;
  if (typeof t !== 'string') return 'any';
  return SHORT_TYPE[t] ?? t;
}

/** The one catalog-line renderer. Takes the plain fields rather than a
 *  Capability or an AgentTool so both lib/capabilities/registry.ts (Capability)
 *  and lib/agent/tools.ts (AgentTool, plus per-turn external-MCP tools that
 *  never become a registered Capability) can call the same function without
 *  either module depending on the other's type. */
export function renderCatalogLine(
  name: string,
  inputSchema: Record<string, any>,
  sensitive: boolean,
  description: string,
): string {
  const props = inputSchema.properties || {};
  const args = Object.keys(props);
  const req = new Set<string>(inputSchema.required || []);
  const sig = args
    .map((a) => `${a}${req.has(a) ? '' : '?'}:${shortType(props[a])}`)
    .join(', ') || '—';
  return `${name}(${sig})${sensitive ? ' [needs approval]' : ''} — ${description}`;
}

/** Full catalog line, byte-identical to toolCatalogForPrompt()'s — both call
 *  renderCatalogLine(). See the comment above SHORT_TYPE for why. */
function fullLineOf(c: Capability): string {
  return renderCatalogLine(c.name, c.inputSchema, isSensitive(c), c.description);
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
