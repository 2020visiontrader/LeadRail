// Shared LeadRail tool registry — the single source of truth for every
// callable action. Two front doors consume this exact map:
//   1. The external MCP server (app/api/mcp/route.ts) — JSON-RPC over HTTP.
//   2. The internal agent loop (lib/agent/loop.ts) — the in-app "LeadRail AI"
//      chatbot that drives these tools from plain language.
// One registry means in-app and machine callers can never drift apart.
//
// Every tool is a THIN wrapper over an existing service — no business logic is
// reimplemented here. Account scope is always passed by the caller from the
// authenticated session; tools never trust client-supplied account ids.
//
// `sensitive: true` marks a tool that mutates external state or spends money.
// The agent loop NEVER auto-executes a sensitive tool — it surfaces a proposal
// and waits for explicit human approval (the same gate content publishing will
// reuse). MCP callers are already machine-authenticated, so they may call them
// directly.

import { z } from 'zod';
import { supabase, getContacts, getVentures, getVenture, updateContact, updateVenture, insertCampaignAsset, getConnections } from '@/lib/db';
import { getCampaignAssets, getPipelineStages, createDeal, moveDealStage, createNote } from '@/lib/crm';
import { listConversations } from '@/lib/conversations';
import { listAdAccounts, getInsights } from '@/lib/social/meta-ads';
import {
  createCampaignRecord, launchCampaign, pauseCampaign, syncCampaign,
} from '@/lib/campaigns/actions';
import { getCampaignAbReport } from '@/lib/campaigns/analytics';
import { notionSearch, notionGetPageText } from '@/lib/integrations/notion';
import { driveSearch, driveReadFileText } from '@/lib/integrations/gdrive';
import { searchPeople, matchPerson } from '@/lib/integrations/apollo';
import { sendOutreachEmail } from '@/lib/outreach';
import { listSequences, enrollContacts } from '@/lib/sequences';
import { listTags, addTagToContact } from '@/lib/tags';
import { generateOutreach, generateContentPost } from '@/lib/ai/generation';
import { getComments, replyToComment, sendInstagramMessage } from '@/lib/social/meta-engagement';
import { publishToInstagramForAccount, publishToFacebookPage } from '@/lib/integrations/meta';

export interface AgentTool {
  /** Short human title shown in approval proposals. */
  title: string;
  description: string;
  /** JSON Schema for MCP tools/list. */
  inputSchema: Record<string, any>;
  /** Runtime validation for both callers. */
  zod: z.ZodTypeAny;
  /** Mutates external state / spends money → agent must get approval first. */
  sensitive?: boolean;
  run: (accountId: string, args: any) => Promise<any>;
}

const obj = (props: Record<string, any>, required: string[] = []) =>
  ({ type: 'object', properties: props, required, additionalProperties: false });
const S = { string: { type: 'string' }, number: { type: 'number' } } as const;

/** Resolve the brand ids in scope, optionally narrowed to one. */
async function brandScope(accountId: string, brandId?: string): Promise<string[]> {
  if (brandId) return [brandId];
  return (await getVentures(accountId)).map((b: any) => b.id);
}

export const TOOLS: Record<string, AgentTool> = {
  // ---- read: context the agent reasons over ------------------------------
  listVentures: {
    title: 'List ventures',
    description: 'List the ventures/brands in the account (id, name). Use to resolve a venture name the user typed into its id.',
    inputSchema: obj({}),
    zod: z.object({}),
    // Compact projection: full rows carry large JSON columns that overflow the
    // agent's observation cap and cause miscounts. id + name is all it needs.
    run: async (accountId) => (await getVentures(accountId)).map((v: any) => ({ id: v.id, name: v.name })),
  },
  listAdAccounts: {
    title: 'List Meta ad accounts',
    description: 'List the connected Meta ad accounts (id is act_<id>). Use to resolve which ad account to build a campaign in.',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => listAdAccounts(accountId),
  },
  listCampaigns: {
    title: 'List campaigns',
    description: 'List ad campaigns, optionally filtered to one venture.',
    inputSchema: obj({ brandId: S.string, limit: S.number }),
    zod: z.object({ brandId: z.string().optional(), limit: z.number().optional() }),
    run: async (accountId, { brandId, limit = 100 }) => {
      const brandIds = await brandScope(accountId, brandId);
      if (!brandIds.length) return [];
      const { data, error } = await supabase.from('ad_campaigns').select('*')
        .in('brand_id', brandIds).order('created_at', { ascending: false }).limit(limit);
      if (error) throw error;
      return data;
    },
  },
  getCampaign: {
    title: 'Get campaign',
    description: 'Get a single campaign by id (must belong to the account).',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: async (accountId, { id }) => {
      const brandIds = await brandScope(accountId);
      const { data } = await supabase.from('ad_campaigns').select('*').eq('id', id).single();
      if (!data || !brandIds.includes(data.brand_id)) throw new Error('Campaign not found');
      return data;
    },
  },
  listAdSets: {
    title: 'List ad sets',
    description: 'List ad sets under a campaign (local records mirroring Meta).',
    inputSchema: obj({ campaignId: S.string }, ['campaignId']),
    zod: z.object({ campaignId: z.string() }),
    run: async (accountId, { campaignId }) => {
      // getCampaign enforces ownership before we expose children.
      await TOOLS.getCampaign.run(accountId, { id: campaignId });
      const { data, error } = await supabase.from('ad_sets').select('*')
        .eq('campaign_id', campaignId).order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  },
  listAds: {
    title: 'List ads',
    description: 'List ads under a campaign (local records mirroring Meta).',
    inputSchema: obj({ campaignId: S.string }, ['campaignId']),
    zod: z.object({ campaignId: z.string() }),
    run: async (accountId, { campaignId }) => {
      await TOOLS.getCampaign.run(accountId, { id: campaignId });
      const { data, error } = await supabase.from('ads').select('*')
        .eq('campaign_id', campaignId).order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  },
  listAssets: {
    title: 'List campaign assets',
    description: 'List creative assets attached to a campaign.',
    inputSchema: obj({ campaignId: S.string }, ['campaignId']),
    zod: z.object({ campaignId: z.string() }),
    run: (accountId, { campaignId }) => getCampaignAssets(campaignId, accountId),
  },
  getInsights: {
    title: 'Get Meta insights',
    description: 'Pull live Meta insights (spend/impressions/clicks/CPC/CPM/CTR) for a Meta object id (campaign, ad set, or ad).',
    inputSchema: obj({ metaObjectId: S.string }, ['metaObjectId']),
    zod: z.object({ metaObjectId: z.string() }),
    run: (accountId, { metaObjectId }) => getInsights(accountId, metaObjectId),
  },
  listLeads: {
    title: 'List leads',
    description: 'List leads/contacts across the account.',
    inputSchema: obj({ limit: S.number, offset: S.number }),
    zod: z.object({ limit: z.number().optional(), offset: z.number().optional() }),
    run: (accountId, { limit = 50, offset = 0 }) => getContacts(accountId, 'all', limit, offset),
  },
  getLead: {
    title: 'Get lead',
    description: 'Get a single lead/contact by id.',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: async (accountId, { id }) => {
      const { data } = await supabase.from('contacts').select('*').eq('id', id).eq('account_id', accountId).single();
      if (!data) throw new Error('Lead not found');
      return data;
    },
  },
  listConversations: {
    title: 'List conversations',
    description: 'List inbox conversations for the account (email replies and social messages/comments from connected Facebook and Instagram).',
    inputSchema: obj({ limit: S.number }),
    zod: z.object({ limit: z.number().optional() }),
    run: (accountId, { limit = 50 }) => listConversations(accountId, limit),
  },

  // ---- social: connected Facebook/Instagram/Threads accounts ---------------
  listSocialConnections: {
    title: 'List social connections',
    description: 'List the social accounts connected to LeadRail (Facebook Pages, Instagram, Threads) and their status. Use to check what is connected before doing social work.',
    inputSchema: obj({}),
    zod: z.object({}),
    run: async (accountId) => (await getConnections(accountId)).map((c: any) => ({
      provider: c.provider,
      externalId: c.external_id,
      name: c.display_name || c.username || null,
      status: c.status,
      updatedAt: c.updated_at,
    })),
  },
  getComments: {
    title: 'Get post comments',
    description: 'Get the comments on a Facebook post or Instagram media post. Pass the post id and platform ("facebook" or "instagram").',
    inputSchema: obj({ postId: S.string, platform: S.string, limit: S.number }, ['postId', 'platform']),
    zod: z.object({ postId: z.string(), platform: z.enum(['facebook', 'instagram']), limit: z.number().optional() }),
    run: (accountId, { postId, platform, limit }) => getComments(accountId, postId, platform, limit),
  },
  publishSocialPost: {
    title: 'Publish social post (POSTS to social)',
    description: 'Publish a post to a connected Facebook Page or Instagram business account. platform "instagram" needs caption plus imageUrl or videoUrl; "facebook" needs message (link and imageUrl optional). Pass externalId to target a specific account.',
    inputSchema: obj({ platform: S.string, caption: S.string, message: S.string, imageUrl: S.string, videoUrl: S.string, link: S.string, externalId: S.string }, ['platform']),
    zod: z.object({ platform: z.enum(['facebook', 'instagram']), caption: z.string().optional(), message: z.string().optional(), imageUrl: z.string().optional(), videoUrl: z.string().optional(), link: z.string().optional(), externalId: z.string().optional() }),
    sensitive: true,
    run: (accountId, { platform, ...rest }) => platform === 'instagram'
      ? publishToInstagramForAccount(accountId, { caption: rest.caption || '', imageUrl: rest.imageUrl, videoUrl: rest.videoUrl }, rest.externalId)
      : publishToFacebookPage(accountId, { message: rest.message || '', link: rest.link, imageUrl: rest.imageUrl }, rest.externalId),
  },
  replyToComment: {
    title: 'Reply to comment (POSTS to social)',
    description: 'Reply to a comment on a Facebook post or Instagram media. Pass the comment id, reply text, and platform ("facebook" or "instagram").',
    inputSchema: obj({ commentId: S.string, message: S.string, platform: S.string, externalId: S.string }, ['commentId', 'message', 'platform']),
    zod: z.object({ commentId: z.string(), message: z.string(), platform: z.enum(['facebook', 'instagram']), externalId: z.string().optional() }),
    sensitive: true,
    run: (accountId, { commentId, message, platform, externalId }) => replyToComment(accountId, commentId, message, platform, externalId),
  },
  sendInstagramMessage: {
    title: 'Reply to Instagram message (SENDS to a real person)',
    description: 'Reply to an Instagram direct message on a connected business account. Pass the recipient id (the sender id of the message, from the Conversations inbox) and the reply text.',
    inputSchema: obj({ recipientId: S.string, text: S.string, externalId: S.string }, ['recipientId', 'text']),
    zod: z.object({ recipientId: z.string(), text: z.string(), externalId: z.string().optional() }),
    sensitive: true,
    run: (accountId, { recipientId, text, externalId }) => sendInstagramMessage(accountId, recipientId, text, externalId),
  },

  // ---- write: gated behind human approval in the agent loop --------------
  createCampaign: {
    title: 'Create campaign',
    description: 'Create a campaign. channel:"meta" + metaAdAccountId also creates a PAUSED Meta campaign (no spend). objective e.g. OUTCOME_TRAFFIC / OUTCOME_LEADS.',
    inputSchema: obj({ brandId: S.string, name: S.string, channel: S.string, budget: S.number, objective: S.string, metaAdAccountId: S.string }, ['brandId', 'name']),
    zod: z.object({ brandId: z.string(), name: z.string(), channel: z.string().optional(), budget: z.number().optional(), objective: z.string().optional(), metaAdAccountId: z.string().optional() }),
    run: (accountId, a) => createCampaignRecord(accountId, a),
  },
  importAsset: {
    title: 'Attach creative asset',
    description: 'Attach a creative asset (image/video URL) to a campaign so it can be launched.',
    inputSchema: obj({ campaignId: S.string, url: S.string, kind: S.string }, ['campaignId', 'url']),
    zod: z.object({ campaignId: z.string(), url: z.string().url(), kind: z.enum(['image', 'video']).optional() }),
    run: (accountId, { campaignId, url, kind }) => insertCampaignAsset({ campaign_id: campaignId, account_id: accountId, url, kind: kind || 'image' }),
  },
  launchCampaign: {
    title: 'Launch campaign (SPENDS MONEY)',
    description: '⚠ Activates a LIVE PAID Meta ad and spends budget. Builds ad set + creative + ad from the first asset, then sets everything ACTIVE. Requires a linked Meta campaign, budget>0, ≥1 asset, and a connected Facebook Page.',
    inputSchema: obj({ id: S.string, message: S.string, link: S.string, dailyBudget: S.number }, ['id']),
    zod: z.object({ id: z.string(), message: z.string().optional(), link: z.string().optional(), dailyBudget: z.number().optional() }),
    sensitive: true,
    run: (accountId, { id, ...opts }) => launchCampaign(accountId, id, opts),
  },
  pauseCampaign: {
    title: 'Pause campaign',
    description: 'Pause a live Meta campaign (stops spend).',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: (accountId, { id }) => pauseCampaign(accountId, id),
  },
  syncCampaign: {
    title: 'Sync campaign insights',
    description: 'Pull live Meta insights and update local spend for a campaign.',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: (accountId, { id }) => syncCampaign(accountId, id),
  },
  analyzeCampaign: {
    title: 'Analyze campaign (A/B)',
    description: 'Compare a campaign\'s creatives on click-through, cost, and results; returns the winner and a plain-language recommendation on what to scale, pause, and test next. Read-only.',
    inputSchema: obj({ id: S.string }, ['id']),
    zod: z.object({ id: z.string() }),
    run: (accountId, { id }) => getCampaignAbReport(accountId, id),
  },
  // ---- read: external knowledge sources ----------------------------------
  searchNotion: {
    title: 'Search Notion',
    description: 'Search connected Notion for pages/databases matching a query. Use when the user references notes, docs, or knowledge kept in Notion.',
    inputSchema: obj({ query: S.string, limit: S.number }, ['query']),
    zod: z.object({ query: z.string(), limit: z.number().optional() }),
    run: (accountId, { query, limit }) => notionSearch(accountId, query, limit),
  },
  searchDrive: {
    title: 'Search Google Drive',
    description: 'Search connected Google Drive files by name. Use when the user references a document, sheet, or asset stored in Drive.',
    inputSchema: obj({ query: S.string, limit: S.number }, ['query']),
    zod: z.object({ query: z.string(), limit: z.number().optional() }),
    run: (accountId, { query, limit }) => driveSearch(accountId, query, limit),
  },
  readNotionPage: {
    title: 'Read Notion page',
    description: 'Read the text content of a specific Notion page by id (get the id from searchNotion first).',
    inputSchema: obj({ pageId: S.string, max: S.number }, ['pageId']),
    zod: z.object({ pageId: z.string(), max: z.number().optional() }),
    run: (accountId, { pageId, max }) => notionGetPageText(accountId, pageId, max),
  },
  readDriveFile: {
    title: 'Read Google Drive file',
    description: 'Read the text content of a specific Google Drive file by id (get the id from searchDrive first). Exports Google Docs to text.',
    inputSchema: obj({ fileId: S.string, maxChars: S.number }, ['fileId']),
    zod: z.object({ fileId: z.string(), maxChars: z.number().optional() }),
    run: (accountId, { fileId, maxChars }) => driveReadFileText(accountId, fileId, maxChars),
  },

  // ---- sourcing: find & reveal leads (SPENDS credits → approval) ----------
  sourceLeads: {
    title: 'Source leads (uses credits)',
    description: 'Find new leads/people matching a target profile (titles, seniority, location, industry, keywords, company size). Returns candidates with names/companies; emails stay masked until you reveal one. Uses sourcing credits.',
    inputSchema: obj({ titles: { type: 'array', items: { type: 'string' } }, seniority: { type: 'array', items: { type: 'string' } }, location: S.string, industry: S.string, keywords: S.string, companySize: S.string, limit: S.number }),
    zod: z.object({ titles: z.array(z.string()).optional(), seniority: z.array(z.string()).optional(), location: z.string().optional(), industry: z.string().optional(), keywords: z.string().optional(), companySize: z.string().optional(), limit: z.number().max(25).optional() }),
    sensitive: true,
    run: (_accountId, a) => searchPeople({ titles: a.titles, seniority: a.seniority, location: a.location, industry: a.industry, keywords: a.keywords, company_size: a.companySize, limit: a.limit ?? 10 }),
  },
  enrichLead: {
    title: 'Reveal lead details (uses credits)',
    description: 'Reveal a lead\'s verified email and full profile. Pass a lead id (an existing contact) OR identity hints (email/linkedinUrl/name+company). Uses sourcing credits.',
    inputSchema: obj({ contactId: S.string, email: S.string, linkedinUrl: S.string, name: S.string, company: S.string }),
    zod: z.object({ contactId: z.string().optional(), email: z.string().optional(), linkedinUrl: z.string().optional(), name: z.string().optional(), company: z.string().optional() }),
    sensitive: true,
    run: async (accountId, a) => {
      let keys: any = { email: a.email, linkedin_url: a.linkedinUrl, name: a.name, company: a.company };
      if (a.contactId) {
        const c: any = await TOOLS.getLead.run(accountId, { id: a.contactId });
        keys = { id: c.apollo_person_id || null, email: c.email || a.email, name: c.name || a.name, company: c.company || a.company, linkedin_url: c.linkedin_url || a.linkedinUrl };
      }
      return matchPerson(keys);
    },
  },

  // ---- outreach: draft (auto) / send & enroll (real people → approval) ----
  draftOutreach: {
    title: 'Draft outreach email',
    description: 'Draft a personalized outreach email to a lead, grounded in the venture pitch and sender persona. Returns a subject + body for review. Does NOT send.',
    inputSchema: obj({ contactId: S.string, goal: S.string, tone: S.string }, ['contactId', 'goal']),
    zod: z.object({ contactId: z.string(), goal: z.string(), tone: z.string().optional() }),
    run: async (accountId, { contactId, goal, tone }) => {
      const contact: any = await TOOLS.getLead.run(accountId, { id: contactId });
      const v: any = contact.brand_id ? await getVenture(contact.brand_id) : (await getVentures(accountId))[0];
      return generateOutreach({
        contact,
        venture: {
          name: v?.name || 'our company', pitch: v?.pitch, senderName: v?.sender_name,
          senderRole: v?.sender_role, signature: v?.signature, defaultCta: v?.default_cta,
          skills: Array.isArray(v?.skills) ? v.skills : null,
        },
        goal, tone,
      });
    },
  },
  sendEmail: {
    title: 'Send email to lead (SENDS to a real person)',
    description: 'Send an email to a lead now. Provide the lead id, subject, and body (html). This sends a real message — draft with draftOutreach first if unsure.',
    inputSchema: obj({ contactId: S.string, subject: S.string, html: S.string }, ['contactId', 'subject']),
    zod: z.object({ contactId: z.string(), subject: z.string(), html: z.string().optional() }),
    sensitive: true,
    run: (accountId, { contactId, subject, html }) => sendOutreachEmail({ contactId, subject, html, accountId }),
  },
  listSequences: {
    title: 'List sequences',
    description: 'List the outreach follow-up sequences for a venture (resolve a venture id with listVentures first).',
    inputSchema: obj({ brandId: S.string }, ['brandId']),
    zod: z.object({ brandId: z.string() }),
    run: (_accountId, { brandId }) => listSequences(brandId),
  },
  enrollInSequence: {
    title: 'Enroll leads in sequence (SENDS to real people)',
    description: 'Enroll one or more leads into an outreach sequence, which will send them scheduled follow-up emails. Provide the sequence id and lead ids.',
    inputSchema: obj({ sequenceId: S.string, contactIds: { type: 'array', items: { type: 'string' } } }, ['sequenceId', 'contactIds']),
    zod: z.object({ sequenceId: z.string(), contactIds: z.array(z.string()).min(1) }),
    sensitive: true,
    run: (accountId, { sequenceId, contactIds }) => enrollContacts(sequenceId, accountId, contactIds),
  },

  // ---- CRM / pipeline: internal state (auto) -----------------------------
  listStages: {
    title: 'List pipeline stages',
    description: 'List the CRM pipeline stages (optionally for one venture). Use to resolve a stage name to its id before moving a deal.',
    inputSchema: obj({ brandId: S.string }),
    zod: z.object({ brandId: z.string().optional() }),
    run: (accountId, { brandId }) => getPipelineStages(accountId, brandId),
  },
  createDeal: {
    title: 'Create deal',
    description: 'Create a deal in the pipeline. Provide a name; optionally a stage id, the lead id it is for, venture id, and amount.',
    inputSchema: obj({ name: S.string, stageId: S.string, contactId: S.string, brandId: S.string, amount: S.number }, ['name']),
    zod: z.object({ name: z.string(), stageId: z.string().optional(), contactId: z.string().optional(), brandId: z.string().optional(), amount: z.number().optional() }),
    run: (accountId, a) => createDeal({ account_id: accountId, name: a.name, stage_id: a.stageId, primary_contact_id: a.contactId, brand_id: a.brandId, amount: a.amount }),
  },
  moveDeal: {
    title: 'Move deal to stage',
    description: 'Move a deal to a different pipeline stage (resolve the stage id with listStages first).',
    inputSchema: obj({ id: S.string, stageId: S.string }, ['id', 'stageId']),
    zod: z.object({ id: z.string(), stageId: z.string() }),
    run: (accountId, { id, stageId }) => moveDealStage(id, accountId, stageId),
  },
  addNote: {
    title: 'Add note',
    description: 'Add a note to a lead and/or deal. Provide the note body; optionally the lead id and/or deal id it attaches to.',
    inputSchema: obj({ body: S.string, contactId: S.string, dealId: S.string, brandId: S.string }, ['body']),
    zod: z.object({ body: z.string(), contactId: z.string().optional(), dealId: z.string().optional(), brandId: z.string().optional() }),
    run: (accountId, a) => createNote({ account_id: accountId, body: a.body, contact_id: a.contactId, deal_id: a.dealId, brand_id: a.brandId }),
  },
  updateLeadStatus: {
    title: 'Update lead status',
    description: 'Set a lead\'s status. One of: new, outreaching, replied, qualified, dead.',
    inputSchema: obj({ id: S.string, status: S.string }, ['id', 'status']),
    zod: z.object({ id: z.string(), status: z.enum(['new', 'outreaching', 'replied', 'qualified', 'dead']) }),
    run: (accountId, { id, status }) => updateContact(id, accountId, { status }),
  },
  listTags: {
    title: 'List tags',
    description: 'List the lead tags in the account.',
    inputSchema: obj({}),
    zod: z.object({}),
    run: (accountId) => listTags(accountId),
  },
  tagLead: {
    title: 'Tag lead',
    description: 'Add a tag to a lead. Pass an existing tagId, or a name (a new tag is created if needed).',
    inputSchema: obj({ contactId: S.string, tagId: S.string, name: S.string, color: S.string }, ['contactId']),
    zod: z.object({ contactId: z.string(), tagId: z.string().optional(), name: z.string().optional(), color: z.string().optional() }),
    run: (accountId, { contactId, tagId, name, color }) => addTagToContact(accountId, contactId, { tagId, name, color }),
  },

  // ---- persona: sender identity (auto) -----------------------------------
  getPersona: {
    title: 'Get sender persona',
    description: 'Get the sender persona for a venture (sender name/role/email, signature, pitch, tone, default CTA).',
    inputSchema: obj({ brandId: S.string }, ['brandId']),
    zod: z.object({ brandId: z.string() }),
    run: async (accountId, { brandId }) => {
      const v: any = await getVenture(brandId);
      if (!v || (v.account_id && v.account_id !== accountId)) throw new Error('Venture not found');
      return { name: v.sender_name, role: v.sender_role, email: v.sender_email, signature: v.signature, pitch: v.pitch, tone: v.tone, defaultCta: v.default_cta };
    },
  },
  updatePersona: {
    title: 'Update sender persona',
    description: 'Update a venture\'s sender persona fields (senderName, senderRole, senderEmail, signature, pitch, tone, defaultCta).',
    inputSchema: obj({ brandId: S.string, senderName: S.string, senderRole: S.string, senderEmail: S.string, signature: S.string, pitch: S.string, tone: S.string, defaultCta: S.string }, ['brandId']),
    zod: z.object({ brandId: z.string(), senderName: z.string().optional(), senderRole: z.string().optional(), senderEmail: z.string().optional(), signature: z.string().optional(), pitch: z.string().optional(), tone: z.string().optional(), defaultCta: z.string().optional() }),
    run: (accountId, a) => updateVenture(a.brandId, accountId, {
      sender_name: a.senderName, sender_role: a.senderRole, sender_email: a.senderEmail,
      signature: a.signature, pitch: a.pitch, tone: a.tone, default_cta: a.defaultCta,
    }),
  },

  // ---- creative: copy generation (auto — own credits, no send) -----------
  generateAdCopy: {
    title: 'Generate ad/post copy',
    description: 'Generate social/ad post copy (hook, body, hashtags) for a venture. Provide the platform and topic; optionally a hook and CTA.',
    inputSchema: obj({ brandId: S.string, platform: S.string, topic: S.string, hook: S.string, cta: S.string }, ['platform', 'topic']),
    zod: z.object({ brandId: z.string().optional(), platform: z.string(), topic: z.string(), hook: z.string().optional(), cta: z.string().optional() }),
    run: async (accountId, a) => {
      const v: any = a.brandId ? await getVenture(a.brandId) : (await getVentures(accountId))[0];
      return generateContentPost({ venture: { name: v?.name || 'our brand', niche: v?.niche }, platform: a.platform, topic: a.topic, hook: a.hook, cta: a.cta });
    },
  },
};

/** Compact catalog for the agent system prompt — name, purpose, args, gate. */
export function toolCatalogForPrompt(): string {
  return Object.entries(TOOLS).map(([name, t]) => {
    const args = Object.keys(t.inputSchema.properties || {});
    const req = new Set<string>(t.inputSchema.required || []);
    const sig = args.map((a) => (req.has(a) ? a : `${a}?`)).join(', ') || '—';
    return `${name}(${sig})${t.sensitive ? ' [needs approval]' : ''} — ${t.description}`;
  }).join('\n');
}

/** Tool specs for MCP tools/list. */
export function toolSpecs() {
  return Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }));
}

export interface ToolRunResult { ok: boolean; result?: any; error?: string }

/** Validate + execute a tool by name. Never throws — errors are returned so
 *  both the loop and the MCP layer can feed them back to the model. */
export async function runTool(name: string, accountId: string, rawArgs: unknown): Promise<ToolRunResult> {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  const parsed = tool.zod.safeParse(rawArgs ?? {});
  if (!parsed.success) return { ok: false, error: `Invalid arguments: ${parsed.error.message}` };
  try {
    return { ok: true, result: await tool.run(accountId, parsed.data) };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'tool error' };
  }
}
