// High-level generators — combine prompt-improver + marketing scaffolding.
// Text + multi-turn chat run on OpenCode Go (DeepSeek V4 Pro); image generation
// stays on Gemini (invoked directly by the image route). On-demand only (a route
// calls these on explicit request). Nothing here writes to the database or posts
// anywhere; callers decide what to do with the output.

import { generateText, generateChat, type ChatMessage } from './router';
import { buildPersona, improvePrompt } from './prompt-improver';
import { marketingGuidance, whiteLabelGuard, COPY_FRAMEWORKS } from './marketing';
import { HUMANIZE_RULES, stripAiMarkers } from './humanizer';
import { pickModel } from './models';
import { composeSkillGuidance, selectSkillsForGoal } from '@/lib/skills/registry';
import { getLeadGoal, sectorKeywords, type VentureIcp } from '@/lib/taxonomy';

function parseJson<T>(raw: string, fallback: T): T {
  const m = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/\{[\s\S]*\}/);
  const text = m ? (m[1] ?? m[0]) : raw;
  try {
    return JSON.parse(text.trim());
  } catch {
    return fallback;
  }
}

export interface OutreachDraft {
  subject: string;
  body: string;
}

export interface ParsedIcp {
  industry: string;
  titles: string[];
  seniority: string[];
  location: string;
  company_size: string;
  keywords: string;
  limit: number;
  summary: string; // one-line plain-language recap of what will be searched
  reasoning: string; // short "thinking" line: how the request was read given the venture
}

/**
 * Compact context about the venture the user is working inside. Injected into
 * the prompt boxes so each one reasons like an assistant that already knows the
 * brand — its positioning, who it sells to, and its established ICP — instead of
 * treating every request as context-free text. This is the "thinking layer with
 * context": the box grounds its answer in the brand unless the user overrides.
 */
export interface VentureContext {
  name?: string;
  description?: string; // brand description / deck summary — what it is
  leadGoal?: string; // who it wants to reach (investors, customers, partners…)
  sectors?: string[]; // focus sectors
  pitch?: string; // one-line value prop
  icp?: { industry?: string; titles?: string[]; seniority?: string[]; keywords?: string; company_size?: string } | null;
}

/** Render venture context as a short grounding block, or '' when we know nothing. */
export function ventureContextBlock(ctx?: VentureContext | null): string {
  if (!ctx) return '';
  const lines: string[] = [];
  if (ctx.name) lines.push(`Brand: ${ctx.name}`);
  if (ctx.description) lines.push(`What it is: ${ctx.description.slice(0, 600)}`);
  if (ctx.pitch) lines.push(`Value prop: ${ctx.pitch}`);
  if (ctx.leadGoal) lines.push(`Lead goal (who to reach): ${ctx.leadGoal}`);
  if (ctx.sectors?.length) lines.push(`Focus sectors: ${ctx.sectors.join(', ')}`);
  const icp = ctx.icp;
  if (icp && (icp.industry || icp.titles?.length || icp.seniority?.length || icp.keywords)) {
    lines.push(
      `Established ICP: ${[
        icp.industry && `industry=${icp.industry}`,
        icp.titles?.length && `titles=${icp.titles.join('/')}`,
        icp.seniority?.length && `seniority=${icp.seniority.join('/')}`,
        icp.keywords && `keywords=${icp.keywords}`,
        icp.company_size && `size=${icp.company_size}`,
      ].filter(Boolean).join('; ')}`,
    );
  }
  return lines.length ? `VENTURE CONTEXT (ground your answer in this brand; the user is working inside it)\n${lines.join('\n')}` : '';
}

/**
 * Turn a plain-language sourcing request ("Series A SaaS founders in the US")
 * into a structured Apollo ICP the search form can run. Lets a user source
 * leads conversationally instead of hand-tuning keyword/seniority fields.
 */
export async function parseIcpFromText(text: string, context?: VentureContext): Promise<ParsedIcp> {
  const ctxBlock = ventureContextBlock(context);
  const system = buildPersona({
    role: 'a B2B lead-sourcing analyst who maps requests to Apollo People Search filters',
    domain: 'translating natural-language ICP descriptions into Apollo query fields',
    methods:
      'extract only what the user stated or clearly implied; never invent a location or industry that was not asked for. ' +
      (ctxBlock
        ? 'You are sourcing for a specific brand (see VENTURE CONTEXT). When the user is vague ("find me some leads", "who should I reach"), GROUND the ICP in that brand\'s lead goal, sectors, and established ICP. When the user names a specific target, honor it and use the brand only to disambiguate. Never contradict an explicit user instruction.'
        : ''),
    constraints:
      'seniority MUST use Apollo tokens from {owner, founder, c_suite, partner, vp, head, director, manager, senior, entry, intern}; ' +
      'titles are concrete job titles; company_size one of {startup, smb, mid, enterprise} or ""; limit 1-100 (default 25)',
    format:
      'JSON: {"industry": string, "titles": string[], "seniority": string[], "location": string, "company_size": string, "keywords": string, "limit": number, "summary": string, "reasoning": string}',
  });
  const prompt = improvePrompt({
    goal: `Parse this sourcing request into Apollo filters: "${text}"`,
    inputs: ctxBlock ? { venture_context: ctxBlock } : {},
    deliverable: 'One ICP object as JSON. Empty string/array for anything not specified. No preamble.',
    rules: [
      'Never invent a LOCATION the user did not state — leave location empty unless a place is named (location over-constrains and zeroes results)',
      'If the user names a company TYPE / industry but NO explicit person role (e.g. "find marketing agencies"), INFER decision-maker targeting so the search returns reachable leads, not everyone: titles ["Founder","CEO","Owner"] and seniority ["owner","founder","c_suite"]',
      'Map "founders/CEOs" → titles + seniority owner/founder/c_suite',
      'titles MUST be canonical singular job titles ("Founder", "Co-Founder", "CEO", "Owner"), never plural or lowercased',
      'keywords must add a DISTINCT signal from industry; never repeat the industry phrase verbatim in keywords — leave keywords empty if it would only duplicate industry',
      'industry must be a concise SINGULAR descriptor of the target company type ("marketing agency", not "marketing agencies")',
      ctxBlock
        ? 'When the request is thin, fill the ICP from the VENTURE CONTEXT (lead goal + sectors + established ICP); do NOT ask the user to repeat what the brand already implies'
        : 'When the request is thin, make reasonable decision-maker assumptions rather than returning empty filters',
      'summary is one friendly sentence describing exactly what will be searched',
      ctxBlock
        ? 'reasoning is one short sentence (first person, like a colleague thinking out loud) explaining how you read the request AND how the brand context shaped it — e.g. "You didn\'t name a target, so I used the venture\'s stated lead goal + sectors to aim at the right decision-makers."'
        : 'reasoning is one short first-person sentence explaining how you interpreted the request and any assumption you made',
    ],
  });
  const raw = await generateText({ system, prompt, temperature: 0.2 });
  const p = parseJson<Partial<ParsedIcp>>(raw, {});
  const arr = (v: any): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  const industry = String(p.industry || '').trim();
  let titles = arr(p.titles);
  let seniority = arr(p.seniority);
  // Deterministic decision-maker fallback: a company-type prompt with no role must
  // still target reachable leaders (and never leave Titles/Seniority boxes empty).
  if (industry && titles.length === 0 && seniority.length === 0) {
    titles = ['Founder', 'CEO', 'Owner'];
    seniority = ['owner', 'founder', 'c_suite'];
  }
  let summary = String(p.summary || '').trim();
  if (!summary && industry) summary = `Founders & CEOs at ${industry} companies`;
  return {
    industry,
    titles,
    seniority,
    location: String(p.location || '').trim(),
    company_size: String(p.company_size || '').trim(),
    keywords: String(p.keywords || '').trim(),
    limit: Math.min(100, Math.max(1, Number(p.limit) || 25)),
    summary,
    reasoning: stripAiMarkers(String(p.reasoning || '').trim()),
  };
}

/**
 * Refine (or draft) a message template from a plain-language instruction.
 * Returns updated subject + body. Used by the template editor's AI assist.
 */
export async function refineTemplate(opts: {
  instruction: string;
  current?: { subject?: string; body?: string; name?: string };
  venture?: { name?: string };
}): Promise<{ subject: string; body: string }> {
  const system = buildPersona({
    role: `a senior B2B outreach copywriter${opts.venture?.name ? ` for ${opts.venture.name}` : ''}`,
    domain: 'reusable cold-email/message templates with {{merge_tokens}}',
    methods: marketingGuidance({ framework: 'PAS' }),
    constraints:
      'preserve any {{tokens}} like {{name}}, {{company}}; keep it a reusable template (not a one-off); ' +
      'direct, warm, professional; one clear CTA; no spammy phrasing; subject under 60 chars',
    format: 'JSON: {"subject": string, "body": string}',
  });
  const prompt = improvePrompt({
    goal: opts.instruction,
    inputs: {
      current_subject: opts.current?.subject,
      current_body: opts.current?.body,
      template_name: opts.current?.name,
    },
    deliverable: 'The revised template as JSON {subject, body}. No preamble.',
    rules: ['Apply the instruction faithfully', 'Keep merge tokens intact', ...HUMANIZE_RULES],
  });
  const raw = await generateText({ system, prompt, temperature: 0.6 });
  const d = parseJson<{ subject?: string; body?: string }>(raw, {});
  return { subject: stripAiMarkers(d.subject || opts.current?.subject || ''), body: stripAiMarkers(d.body || raw) };
}

/**
 * Generate a personalized outreach email. Does NOT send or persist.
 *
 * The venture carries a per-brand SENDER PERSONA (who you are under this brand:
 * name, role, pitch, tone, signature, default ask) plus optional pinned skills.
 * The GOAL box steers everything: it selects which skills attach (via
 * selectSkillsForGoal) so a "book a call" goal gets the intent router while a
 * "revive a dead thread" goal gets the breakup skill — no hardcoded pair.
 */
export async function generateOutreach(opts: {
  contact: { name?: string; title?: string; company?: string; segment?: string };
  venture: {
    name: string;
    pitch?: string;
    senderName?: string;
    senderRole?: string;
    signature?: string;
    defaultCta?: string;
    skills?: string[] | null;
  };
  goal: string;
  tone?: string;
  framework?: keyof typeof COPY_FRAMEWORKS;
}): Promise<OutreachDraft> {
  const v = opts.venture;
  // Goal-driven skill selection: the AI-goal box decides the skill set. Pinned
  // venture skills win; otherwise the goal text routes them.
  const skillIds = selectSkillsForGoal(opts.goal, v.skills);
  const skillGuidance = composeSkillGuidance(skillIds);

  // Map the plain-language sender profile into the internal persona role. The
  // user never fills a raw "role" scaffolding box — we compose it from their
  // name + role at the venture, falling back to a sane default.
  const senderId = [v.senderName, v.senderRole && `(${v.senderRole})`].filter(Boolean).join(' ');
  const role = senderId
    ? `${senderId} at ${v.name}, writing B2B outreach in the first person`
    : `a senior B2B outreach copywriter for ${v.name}`;

  const system =
    buildPersona({
      role,
      domain: 'cold email to high-intent business contacts',
      methods: `${skillGuidance}\n${marketingGuidance({ framework: opts.framework })}`,
      constraints:
        `${opts.tone || 'direct, warm, professional'} tone; under 120 words; one CTA; no fake familiarity; no spammy phrasing. ` +
        'CRITICAL GROUNDING: never state a statistic, percentage, or metric that is not given in the inputs, and never imply you have already analyzed the recipient\'s own accounts, roster, or data. ' +
        'If the product is early or unlaunched, frame insights as an industry pattern ("teams like yours usually see..."), not as results you already pulled for them. ' +
        'Body: 2-3 short paragraphs separated by a blank line, with the sign-off on its own line after a blank line.',
      format: 'JSON: {"subject": string, "body": string}',
    });
  const prompt = improvePrompt({
    goal: opts.goal,
    inputs: {
      recipient: [opts.contact.name, opts.contact.title, opts.contact.company].filter(Boolean).join(', '),
      segment: opts.contact.segment,
      venture: v.name,
      value_prop: v.pitch,
      sender: senderId || undefined,
      default_ask: v.defaultCta,
      signature: v.signature,
    },
    deliverable: 'One outreach email as JSON {subject, body}. No preamble.',
    rules: [
      'Reference the recipient specifically using only the provided contact fields',
      'Lead with a useful insight framed as an industry pattern, not as data you already have on them',
      'Do NOT invent statistics, percentages, or claims of having analyzed their accounts',
      'Separate the body into short paragraphs with blank lines; put the sign-off on its own line',
      v.defaultCta ? `The single ask should serve the goal; if the goal implies no specific ask, default to: ${v.defaultCta}` : 'Exactly one clear ask',
      v.signature ? `Sign off using this signature block exactly, on its own lines after a blank line:\n${v.signature}` : (senderId ? `Sign off as ${v.senderName || senderId}` : 'End with a simple sign-off'),
      ...HUMANIZE_RULES,
    ],
  });
  const raw = await generateText({ system, prompt, temperature: 0.7 });
  const draft = parseJson<OutreachDraft>(raw, { subject: '', body: raw });
  return { subject: stripAiMarkers(draft.subject || ''), body: stripAiMarkers(draft.body || '') };
}

export interface ContentPost {
  hook: string;
  post_body: string;
  hashtags: string[];
  image_prompt: string; // suggested Nano-Banana prompt for a matching static image
}

/**
 * Generate a single white-label social post for a venture + platform.
 * Output is scrubbed of competitor-platform names and internal repost mechanics.
 */
export async function generateContentPost(opts: {
  venture: { name: string; niche?: string };
  platform: string;
  topic: string;
  hook?: string;
  cta?: string;
}): Promise<ContentPost> {
  const system = buildPersona({
    role: `a short-form content strategist for ${opts.venture.name}`,
    domain: `organic social for ${opts.platform}, niche: ${opts.venture.niche || 'general'}`,
    methods: marketingGuidance({ framework: 'AIDA' }),
    constraints:
      'native to the platform; scroll-stopping hook; one CTA; ' +
      'NEVER name any scheduling/reposting tool or other platform; no "repost as our own" language',
    format: 'JSON: {"hook": string, "post_body": string, "hashtags": string[], "image_prompt": string}',
  });
  const prompt = improvePrompt({
    goal: `Write one ${opts.platform} post about: ${opts.topic}`,
    inputs: { venture: opts.venture.name, niche: opts.venture.niche, preferred_hook: opts.hook, cta: opts.cta },
    deliverable: 'One post as JSON with hook, post_body, hashtags[], and a matching static-image prompt.',
    rules: ['White-label: no competitor/platform names', 'image_prompt describes a static ad image, no video', ...HUMANIZE_RULES],
  });
  const raw = await generateText({ system, prompt, temperature: 0.8 });
  const p = parseJson<ContentPost>(raw, { hook: '', post_body: raw, hashtags: [], image_prompt: '' });
  return {
    hook: stripAiMarkers(whiteLabelGuard(p.hook || '')),
    post_body: stripAiMarkers(whiteLabelGuard(p.post_body || '')),
    hashtags: Array.isArray(p.hashtags) ? p.hashtags : [],
    image_prompt: stripAiMarkers(whiteLabelGuard(p.image_prompt || '')),
  };
}

// ---------------------------------------------------------------------------
// Multi-turn conversational builders. Both keep a JSON envelope: `reply` is the
// message shown in the chat; the structured payload (sequence / draft) is only
// present once the model has enough info, so the UI can offer an "apply" action.
// ---------------------------------------------------------------------------

export interface SequenceChatResult {
  reply: string;
  ready: boolean;
  sequence: SequenceDraft | null;
}

/**
 * Conversational sequence builder. Asks clarifying questions when the request
 * is thin (audience, goal, step count, tone, timing), and only emits a
 * structured sequence once it has enough to be useful. Refines across turns.
 */
export async function sequenceChat(messages: ChatMessage[], opts: { ventureName?: string; context?: VentureContext }): Promise<SequenceChatResult> {
  const ctx = opts.context || (opts.ventureName ? { name: opts.ventureName } : undefined);
  const ctxBlock = ventureContextBlock(ctx);
  const brandName = ctx?.name || opts.ventureName;
  const system = buildPersona({
    role: `a senior B2B outreach cadence strategist${brandName ? ` for ${brandName}` : ''}`,
    domain: 'designing multi-step email sequences with a human collaborator, conversationally',
    methods:
      (ctxBlock ? `${ctxBlock}\n\nUse this brand context to make the cadence specific: pull the value prop, target audience and goal from it instead of asking the user to restate what the brand already implies. ` : '') +
      'If the user request is still vague, ask ONE focused clarifying question at a time (target audience, the goal/CTA, how many steps, tone, timing between steps). ' +
      'When you have enough — or the user says "just build it" — produce the full sequence. Refine it when they give feedback.',
    constraints:
      'reply is a short, friendly chat message (no JSON inside it). ' +
      'Set ready=true and fill sequence ONLY when you are producing/updating a concrete cadence; otherwise ready=false and sequence=null. ' +
      'steps: 2-5, delay_hours strictly increasing from 0, subjects under 60 chars, each body a complete sendable email with {{name}}/{{company}} tokens where useful.',
    format:
      'Return ONLY JSON: {"reply": string, "ready": boolean, "sequence": {"name": string, "steps": [{"step_order": number, "delay_hours": number, "subject": string, "body": string}]} | null}',
  });
  const raw = await generateChat({ system, messages, temperature: 0.6, maxOutputTokens: 2048 });
  const parsed = parseJson<Partial<SequenceChatResult>>(raw, { reply: raw, ready: false, sequence: null });
  const seq = parsed.sequence && Array.isArray(parsed.sequence.steps)
    ? {
        name: stripAiMarkers(parsed.sequence.name || 'New sequence'),
        steps: parsed.sequence.steps.map((s: any, i: number) => ({
          step_order: typeof s.step_order === 'number' ? s.step_order : i,
          delay_hours: typeof s.delay_hours === 'number' ? s.delay_hours : 0,
          subject: stripAiMarkers(s.subject || ''),
          body: stripAiMarkers(s.body || ''),
        })),
      }
    : null;
  return {
    reply: stripAiMarkers(parsed.reply || 'Tell me a bit more about who this sequence is for and the goal.'),
    ready: Boolean(parsed.ready && seq),
    sequence: seq,
  };
}

export interface ReplyChatResult {
  reply: string;
  draft: { subject: string; body: string } | null;
}

/**
 * Conversational inbox reply assistant. Given the inbound message + contact,
 * helps the user craft a reply — asking about the angle/goal when useful, and
 * emitting an editable draft (subject + body) once it has direction.
 */
export async function inboxReplyChat(
  messages: ChatMessage[],
  context: { incomingSubject?: string; incomingBody?: string; fromName?: string; ventureName?: string },
): Promise<ReplyChatResult> {
  const contextBlock =
    `INCOMING MESSAGE\nFrom: ${context.fromName || 'the contact'}\nSubject: ${context.incomingSubject || '(none)'}\n\n${context.incomingBody || '(no body)'}`;
  const system = buildPersona({
    role: `a B2B inbox assistant that drafts replies${context.ventureName ? ` for ${context.ventureName}` : ''}`,
    domain: 'reading an inbound email and drafting the outbound reply with a human in the loop',
    methods:
      'Understand what the contact is asking. If the intended outcome is unclear (book a call? send info? decline?), ask ONE short question. ' +
      'Otherwise draft a reply. Revise it when the user gives feedback. Keep it concise, warm, and specific to their message.',
    constraints:
      'reply is a short chat message to the USER (not the email itself). ' +
      'Put the actual email in draft {subject, body}; set draft=null when you are only asking a question. ' +
      `Base everything on this context:\n${contextBlock}`,
    format: 'Return ONLY JSON: {"reply": string, "draft": {"subject": string, "body": string} | null}',
  });
  const raw = await generateChat({ system, messages, temperature: 0.6, maxOutputTokens: 1536 });
  const parsed = parseJson<Partial<ReplyChatResult>>(raw, { reply: raw, draft: null });
  const draft = parsed.draft && (parsed.draft.subject || parsed.draft.body)
    ? { subject: stripAiMarkers(parsed.draft.subject || `Re: ${context.incomingSubject || ''}`), body: stripAiMarkers(parsed.draft.body || '') }
    : null;
  return { reply: stripAiMarkers(parsed.reply || 'How would you like to respond?'), draft };
}

export interface SequenceStepDraft {
  step_order: number;
  delay_hours: number;
  subject: string;
  body: string;
}

export interface SequenceDraft {
  name: string;
  steps: SequenceStepDraft[];
}

/**
 * Turn a natural-language description into a draft multi-step outreach
 * sequence (name + ordered steps). Does NOT persist — the caller reviews
 * and saves via the sequences API.
 */
export async function generateSequenceDraft(opts: {
  venture: { name: string; pitch?: string };
  description: string;
  templateCategories?: string[];
}): Promise<SequenceDraft> {
  const system = buildPersona({
    role: `a senior B2B lifecycle/outreach strategist for ${opts.venture.name}`,
    domain: 'multi-step email outreach cadences for high-intent business contacts',
    methods: marketingGuidance({ framework: 'AIDA' }),
    constraints:
      '2-5 steps; delay_hours must strictly increase across steps with the first step at delay_hours=0; ' +
      'no fabricated stats or fake case studies; each subject under 60 characters',
    format:
      'JSON: {"name": string, "steps": [{"step_order": number, "delay_hours": number, "subject": string, "body": string}]}',
  });
  const prompt = improvePrompt({
    goal: opts.description,
    inputs: {
      venture: opts.venture.name,
      value_prop: opts.venture.pitch,
      existing_categories: (opts.templateCategories || []).join(', '),
    },
    deliverable: 'One sequence as JSON {name, steps[]}. No preamble.',
    rules: [
      'Steps must be ordered starting at step_order 0',
      'Reuse the existing template categories as a style cue where relevant',
      'Each step body is a complete, sendable email',
      ...HUMANIZE_RULES,
    ],
  });
  const raw = await generateText({ system, prompt, temperature: 0.7 });
  const draft = parseJson<SequenceDraft>(raw, { name: '', steps: [] });
  const steps = Array.isArray(draft.steps) ? draft.steps : [];
  return {
    name: stripAiMarkers(draft.name || ''),
    steps: steps.map((s, i) => ({
      step_order: typeof s.step_order === 'number' ? s.step_order : i,
      delay_hours: typeof s.delay_hours === 'number' ? s.delay_hours : 0,
      subject: stripAiMarkers(s.subject || ''),
      body: stripAiMarkers(s.body || ''),
    })),
  };
}

// ---------------------------------------------------------------------------
// Venture profiling — the onboarding brain. Given the uploaded deck text plus
// the user's chosen lead goal + sectors, distil a stored venture profile:
// a plain-language summary, a one-line value prop, and a concrete ICP that
// seeds the Apollo lead search so results are tailored to this venture.
// ---------------------------------------------------------------------------

export interface VentureProfile {
  summary: string; // plain-language "what this venture is + who it targets"
  value_prop: string; // one crisp positioning line
  icp: VentureIcp; // seeds the lead search form
}

export async function profileVentureFromDeck(opts: {
  ventureName: string;
  description?: string;
  leadGoal?: string; // taxonomy key
  sectors?: string[]; // taxonomy keys
  deckText?: string; // extracted deck text (may be empty)
}): Promise<VentureProfile> {
  const goal = getLeadGoal(opts.leadGoal);
  const secKeywords = sectorKeywords(opts.sectors);
  const skillGuidance = composeSkillGuidance(['skill-deck-profiler', 'skill-value-prop', 'skill-icp-builder', 'skill-grounded-facts']);

  const system = buildPersona({
    role: 'a venture analyst who profiles a company and defines its ideal outreach targets',
    domain: 'turning a pitch deck + stated lead goal into a tailored lead ICP',
    methods:
      skillGuidance +
      '\nSeparate what the deck states from what you infer. Frame the ICP around the LEAD GOAL: ' +
      'investors → the deck is what you pitch them, so target investors/VCs/angels; ' +
      'customers → target the buyer/user described in the deck; ' +
      'partners/marketing_agencies/enterprise → target that relationship. ' +
      'Use the provided sector keywords in the ICP keywords.',
    constraints:
      'Do NOT fabricate metrics, customers, or funding. seniority uses Apollo tokens ' +
      '{owner, founder, c_suite, partner, vp, head, director, manager, senior}; ' +
      'company_size one of {startup, smb, mid, enterprise} or "". Keep summary under 80 words.',
    format:
      'JSON: {"summary": string, "value_prop": string, "icp": {"industry": string, "titles": string[], "seniority": string[], "keywords": string, "company_size": string, "segments": string[]}}',
  });

  const prompt = improvePrompt({
    goal: `Profile the venture "${opts.ventureName}" and define its ideal outreach ICP.`,
    inputs: {
      description: opts.description,
      lead_goal: goal ? `${goal.label} — ${goal.hint}` : opts.leadGoal,
      goal_seniority_bias: goal?.seniority?.join(', '),
      goal_title_cues: goal?.titleCues?.join(', '),
      sectors: (opts.sectors || []).join(', '),
      sector_keywords: secKeywords.join(', '),
      deck_text: opts.deckText ? opts.deckText.slice(0, 40000) : '(no deck uploaded — infer from name/description/goal/sectors)',
    },
    deliverable: 'One venture profile as JSON {summary, value_prop, icp}. No preamble.',
    rules: [
      'Ground every claim in the deck/description; never invent facts',
      'icp.keywords should blend the venture’s niche with the sector keywords',
      'segments are 2-4 short labels for the kinds of leads this venture wants',
    ],
  });

  const raw = await generateText({ system, prompt, temperature: 0.3, maxOutputTokens: 1200, model: pickModel('extract') });
  const p = parseJson<Partial<VentureProfile>>(raw, {});
  const arr = (v: any): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  const icp = (p.icp || {}) as Partial<VentureIcp>;
  // Always fold the goal's seniority + sector keywords in, even if the model missed them.
  const seniority = Array.from(new Set([...arr(icp.seniority), ...(goal?.seniority || [])]));
  const kwParts = [
    ...String(icp.keywords || '').split(',').map((s) => s.trim()),
    ...secKeywords,
  ].filter(Boolean);
  const kw = Array.from(new Set(kwParts.map((s) => s.toLowerCase()))).join(', ');
  return {
    summary: stripAiMarkers(String(p.summary || '').trim()),
    value_prop: stripAiMarkers(String(p.value_prop || '').trim()),
    icp: {
      industry: String(icp.industry || '').trim(),
      titles: arr(icp.titles),
      seniority,
      keywords: kw,
      company_size: String(icp.company_size || '').trim(),
      segments: arr(icp.segments),
    },
  };
}
