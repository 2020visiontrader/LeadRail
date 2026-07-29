// High-level generators — combine prompt-improver + marketing scaffolding + Gemini.
// On-demand only (a route calls these on explicit request). Nothing here writes
// to the database or posts anywhere; callers decide what to do with the output.

import { generateText } from './gemini';
import { buildPersona, improvePrompt } from './prompt-improver';
import { marketingGuidance, whiteLabelGuard, COPY_FRAMEWORKS } from './marketing';
import { HUMANIZE_RULES, stripAiMarkers } from './humanizer';

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

/** Generate a personalized outreach email. Does NOT send or persist. */
export async function generateOutreach(opts: {
  contact: { name?: string; title?: string; company?: string; segment?: string };
  venture: { name: string; pitch?: string };
  goal: string;
  tone?: string;
  framework?: keyof typeof COPY_FRAMEWORKS;
}): Promise<OutreachDraft> {
  const system =
    buildPersona({
      role: `a senior B2B outreach copywriter for ${opts.venture.name}`,
      domain: 'cold email to high-intent business contacts',
      methods: `${marketingGuidance({ framework: opts.framework })}`,
      constraints: `${opts.tone || 'direct, warm, professional'} tone; under 120 words; one CTA; no fake familiarity; no spammy phrasing`,
      format: 'JSON: {"subject": string, "body": string}',
    });
  const prompt = improvePrompt({
    goal: opts.goal,
    inputs: {
      recipient: [opts.contact.name, opts.contact.title, opts.contact.company].filter(Boolean).join(', '),
      segment: opts.contact.segment,
      venture: opts.venture.name,
      value_prop: opts.venture.pitch,
    },
    deliverable: 'One outreach email as JSON {subject, body}. No preamble.',
    rules: ['Reference the recipient specifically', 'Lead with a useful insight', 'Exactly one clear ask', ...HUMANIZE_RULES],
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
