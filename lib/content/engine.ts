// The content engine's generation step.
//
// WHAT THIS FIXES. generateContentPost (lib/ai/generation.ts) took the platform
// as a bare string and knew nothing else about it — no character limit, no image
// spec, no hashtag convention, no CTA shape. It also had no idea what the brand
// sounds like beyond a name and a niche, and no notion of a pillar, so every
// piece it wrote was a fresh guess at constraints that were already written
// down. This assembles the grounding that existed all along and hands the model
// facts instead of adjectives.
//
// It returns the HOOK, BODY and CTA separately rather than one blob, because
// that is the unit the engine works in: the hook stops the scroll, the body
// carries the substance, the CTA asks. They are reviewed, swapped and tested
// independently, and a generator that returns one string cannot be A/B tested
// on its hook alone.

import { generateChat } from '@/lib/ai/router';
import { stripAiMarkers, HUMANIZE_RULES } from '@/lib/ai/humanizer';
import { supabase } from '@/lib/db';
import { getPlatformSpec, platformSpecBlock, nextPillar, type PlatformSpec } from './store';
import { loadCanon, canonBlock, scoreLinearity, type BrandCanon, type LinearityReport } from './canon';

export interface GeneratedContent {
  title: string;
  hook: string;
  body: string;
  cta: string;
  hashtags: string[];
  imagePrompt: string;
  keyAngle: string;
  targetAudience: string;
  pillar: string | null;
  pillarId: string | null;
  platform: string;
  charCount: number;
  /** True when the assembled post is within the platform's hard limit. False
   *  is reported, never silently trimmed — a truncated CTA is worse than a
   *  visible warning, and the caller may prefer to regenerate. */
  withinLimit: boolean;
  /** Whether this reads as THIS brand. Null when no thesis is set. */
  linearity: LinearityReport | null;
}

interface BrandKit {
  name: string;
  description?: string | null;
  pitch?: string | null;
  sectors?: string[] | null;
  tone_of_voice?: string | null;
  platform_strategy?: string | null;
  content_examples?: string | null;
  key_messaging?: string | null;
}

/** Load the brand kit, or null when the piece belongs to no venture. Every
 *  field is optional — the engine must produce something useful from a bare
 *  topic, which is the normal case before a workspace is filled in. */
async function loadBrandKit(accountId: string, brandId?: string | null): Promise<BrandKit | null> {
  if (!brandId) return null;
  const { data } = await supabase
    .from('brands')
    .select('name, description, pitch, sectors, tone_of_voice, platform_strategy, content_examples, key_messaging')
    .eq('id', brandId).eq('account_id', accountId).maybeSingle();
  return (data as BrandKit) ?? null;
}

function brandBlock(kit: BrandKit | null): string {
  if (!kit) return 'NO BRAND SELECTED — write for a general professional audience and keep claims generic. Do not invent a company, a product name, or a customer.';
  const lines = [`BRAND — ${kit.name}. Write as this brand, not about it.`];
  if (kit.description) lines.push(`- What it is: ${kit.description}`);
  if (kit.pitch) lines.push(`- Positioning: ${kit.pitch}`);
  if (kit.key_messaging) lines.push(`- Key messaging: ${kit.key_messaging}`);
  if (kit.tone_of_voice) lines.push(`- Tone of voice: ${kit.tone_of_voice}`);
  if (kit.platform_strategy) lines.push(`- Platform strategy: ${kit.platform_strategy}`);
  if (kit.sectors?.length) lines.push(`- Sectors: ${kit.sectors.join(', ')}`);
  if (kit.content_examples) {
    // Deliberately last and deliberately verbatim. Three real posts that worked
    // steer a model far harder than any adjective, so they get the final word
    // in the prompt rather than being paraphrased into a style note.
    lines.push(`- Posts that have worked for this brand — match this register, do NOT copy the content:\n${kit.content_examples}`);
  }
  return lines.join('\n');
}

function pillarBlock(pillar: any | null): string {
  if (!pillar) return '';
  const bits = [`PILLAR — this piece serves "${pillar.name}".`];
  if (pillar.pain) bits.push(`- The pain it names: ${pillar.pain}`);
  if (pillar.promise) bits.push(`- The relief it promises: ${pillar.promise}`);
  bits.push('- The hook should come from the pain and the payoff from the promise. Do not name the pillar itself; nobody outside the company knows what it means.');
  return bits.join('\n');
}

function parseJson<T>(raw: string, fallback: T): T {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return fallback;
  try { return JSON.parse(m[0]) as T; } catch { return fallback; }
}

export interface GenerateContentInput {
  accountId: string;
  topic: string;
  platform: string;
  brandId?: string | null;
  /** Skip pillar rotation and use this one. Omit to let the engine pick the
   *  least-recently-used pillar (see nextPillar). */
  pillarId?: string | null;
  funnelStage?: string | null;
  /** Operator steer — a hook they already have in mind, or a required CTA. */
  hook?: string | null;
  cta?: string | null;
  /** 'organic' optimises for retention, saves and shareability; 'paid'
   *  optimises for click-through and cost per acquisition. These are not the
   *  same brief with different words — see the note in the prompt below. */
  intent?: 'organic' | 'paid';
}

/**
 * Generate one piece of content, fully grounded.
 *
 * Runs on the heavy tier: this is the deliverable a person reads and publishes,
 * not a routing decision, so it gets the best model on the ladder rather than
 * the fastest.
 */
export async function generateContent(input: GenerateContentInput): Promise<GeneratedContent> {
  const platform = input.platform.toLowerCase();
  const [spec, kit, canon, pillar] = await Promise.all([
    getPlatformSpec(input.accountId, platform).catch(() => null as PlatformSpec | null),
    loadBrandKit(input.accountId, input.brandId).catch(() => null),
    loadCanon(input.accountId, input.brandId).catch(() => null as BrandCanon | null),
    input.pillarId
      ? Promise.resolve(
          supabase.from('content_pillars').select('*').eq('id', input.pillarId)
            .eq('account_id', input.accountId).maybeSingle(),
        ).then((r) => r.data).catch(() => null)
      : nextPillar(input.accountId, input.brandId).catch(() => null),
  ]);

  const intent = input.intent ?? 'organic';
  const system = [
    'You are the content engine for an operator console. You write one finished piece of content per call — publish-ready, not a sketch.',
    '',
    // THE THESIS GOES FIRST, ALONE. It is the one instruction that must survive
    // contact with every other constraint below it, and attention is highest
    // here. See lib/content/canon.ts.
    canonBlock(canon),
    '',
    intent === 'paid'
      ? [
          'INTENT — PAID. This is direct response, not brand content.',
          '- The hook must create friction: name the cost, the loss or the problem the reader is living with right now.',
          '- One unmistakable ask. No "learn more" — say what happens when they click.',
          '- Every claim must be substantiable. Ad networks reject unverifiable results, before/after framing, and implied personal attributes; write as if a reviewer will ask for the evidence.',
          '- Optimise for click-through and cost per acquisition, not for applause.',
        ].join('\n')
      : [
          'INTENT — ORGANIC. This earns attention, it does not buy it.',
          '- Optimise for retention and saves: the reader should finish it, and want it later.',
          '- Give the value away in the post. A piece that withholds the point to drive a click reads as an ad and is treated as one.',
          '- A call to action is optional here and should be absent more often than not.',
        ].join('\n'),
    '',
    brandBlock(kit),
    '',
    platformSpecBlock(spec) || `PLATFORM — ${platform}. No stored constraints for this surface; keep it conservative and note nothing about limits you do not know.`,
    '',
    pillarBlock(pillar),
    '',
    'STRUCTURE — three separate parts, never merged:',
    '- hook: the first line. It stops the scroll by naming a specific situation, not a category. No preamble, no throat-clearing, no "In today\'s world".',
    '- body: the substance. Before → after, the mechanism, or the proof. Concrete over abstract; a named number beats an adjective every time.',
    '- cta: one ask, in the format the platform section above specifies. Exactly one.',
    '',
    'NEVER invent a statistic, a customer name, a case study, or a result. If a claim would need a number you have not been given, write the sentence without the number.',
    'Never mention scheduling tools, other platforms, vendors, or model names.',
    ...HUMANIZE_RULES.map((r) => `- ${r}`),
    '',
    'Return ONLY this JSON object and nothing else:',
    '{"title": string, "hook": string, "body": string, "cta": string, "hashtags": string[], "image_prompt": string, "key_angle": string, "target_audience": string}',
    'title: a short internal label for the board, not a headline the audience sees.',
    'key_angle: one line saying what makes this piece different from the obvious take.',
    'image_prompt: describes a single still image to accompany the post. No video, no text overlay instructions unless the platform spec asks for them.',
  ].filter(Boolean).join('\n');

  const userTurn = [
    `Topic: ${input.topic}`,
    input.funnelStage ? `Funnel stage: ${input.funnelStage} — pitch the ask accordingly.` : '',
    input.hook ? `The operator wants this hook, or something very close to it: "${input.hook}"` : '',
    input.cta ? `The CTA must be: "${input.cta}"` : '',
    'Write it now.',
  ].filter(Boolean).join('\n');

  const raw = await generateChat({
    system,
    messages: [{ role: 'user', content: userTurn }],
    temperature: 0.8,
    accountId: input.accountId,
    task: 'draft',
    preferTier: 'heavy',
  });

  const p = parseJson<any>(raw, {});
  const hook = stripAiMarkers(String(p.hook || '').trim());
  const body = stripAiMarkers(String(p.body || '').trim());
  const cta = stripAiMarkers(String(p.cta || '').trim());
  const assembled = [hook, body, cta].filter(Boolean).join('\n\n');

  // Scored AFTER generation, never asked of the generator. A model reviewing
  // its own output for brand fit produces agreeable answers; this is the gate
  // for the cases where it was confident and wrong.
  const linearity = await scoreLinearity(
    input.accountId, input.brandId, assembled, canon,
  ).catch(() => null);

  return {
    title: String(p.title || input.topic).slice(0, 200),
    hook,
    body,
    cta,
    hashtags: Array.isArray(p.hashtags) ? p.hashtags.map(String) : [],
    imagePrompt: stripAiMarkers(String(p.image_prompt || '').trim()),
    keyAngle: String(p.key_angle || '').trim(),
    targetAudience: String(p.target_audience || '').trim(),
    pillar: pillar?.name ?? null,
    pillarId: pillar?.id ?? null,
    platform,
    charCount: assembled.length,
    // Reported, never silently enforced — see the note on the interface.
    withinLimit: !spec?.char_limit || assembled.length <= spec.char_limit,
    linearity,
  };
}
