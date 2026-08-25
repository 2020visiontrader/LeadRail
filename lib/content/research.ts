// The research engine — four passes, one vault.
//
// WHAT THIS REPLACES. The assistant could already search the web and read a
// public profile, but every finding died in the transcript. Ask it to research
// five competitors on Monday and it repeats the whole sweep on Tuesday, because
// nothing kept what it learned.
//
// THE FOUR PASSES, and why these four. They are the questions a brand cannot
// write good content without answering, and each needs a different source:
//
//   competitor  what rivals are actually saying, and the hooks they lead with
//   trend       what the platforms are rewarding right now
//   search      what people type when they have this problem
//   audience    the words the audience uses for it themselves
//
// The last one is the one most often skipped and the most valuable: a brand
// that describes its category in its own vocabulary writes copy nobody searches
// for and nobody recognises.
//
// PARALLEL, because they are independent. Four sequential web searches in front
// of a person waiting on an intake is a minute of dead time for no reason. A
// pass that fails does not fail the sweep — it is reported as a gap, because
// "we could not learn this" is itself a finding a human should see rather than
// a silence they will mistake for completeness.

import { supabase, dbReady } from '@/lib/db';
import { webSearch } from '@/lib/integrations/websearch';
import { generateChat } from '@/lib/ai/router';

export type ResearchPass = 'competitor' | 'trend' | 'search' | 'audience';

export const RESEARCH_PASSES: ResearchPass[] = ['competitor', 'trend', 'search', 'audience'];

export interface ResearchFinding {
  pass: ResearchPass;
  finding: string;
  source?: string | null;
  sourceKind?: string | null;
  detail?: Record<string, any>;
}

export interface SweepResult {
  findings: ResearchFinding[];
  /** Passes that produced nothing, with the reason. Never silently omitted —
   *  a gap the operator cannot see is a gap they will assume was covered. */
  gaps: { pass: ResearchPass; reason: string }[];
}

/** What each pass asks the open web, given a brand description. Written as
 *  search intent rather than as a question to a model — these strings go to a
 *  search engine, and a well-formed query beats a well-formed sentence. */
function queriesFor(pass: ResearchPass, subject: string, competitors: string[]): string[] {
  switch (pass) {
    case 'competitor':
      // Named competitors first; fall back to discovering them when none given.
      return competitors.length
        ? competitors.slice(0, 4).map((c) => `${c} positioning messaging homepage`)
        : [`${subject} competitors comparison`, `best ${subject} alternatives`];
    case 'trend':
      return [`${subject} trends 2026`, `${subject} social media what works now`];
    case 'search':
      return [`${subject} how to`, `${subject} problems`];
    case 'audience':
      // Community sources, because this pass is after vocabulary rather than
      // authority — how people phrase the problem unprompted.
      return [`${subject} reddit discussion`, `${subject} "I need" OR "struggling with"`];
    default:
      return [subject];
  }
}

/** Turn raw search hits into short, sourced findings.
 *
 *  A model is used here for one narrow job — reading result snippets and saying
 *  what they mean — and is explicitly forbidden from adding anything the
 *  snippets do not support. That boundary is the difference between research
 *  and confident invention, and it is the same rule the rest of the assistant
 *  runs on. */
async function distil(
  accountId: string,
  pass: ResearchPass,
  subject: string,
  hits: { title: string; url: string; snippet: string }[],
): Promise<ResearchFinding[]> {
  if (!hits.length) return [];

  const PASS_BRIEF: Record<ResearchPass, string> = {
    competitor: 'What each competitor claims, and the hook or angle they lead with. Name the competitor in the finding.',
    trend: 'What formats, angles or topics are currently being rewarded in this space.',
    search: 'What people are actually trying to find out, phrased as the question they are asking.',
    audience: 'The exact words and phrases the audience uses for this problem. Quote their vocabulary, do not translate it into marketing language.',
  };

  const system = [
    `You are the ${pass} research pass for a brand working on: ${subject}.`,
    PASS_BRIEF[pass],
    '',
    'Rules, and the first one is absolute:',
    '- Every finding must be supported by one of the results below. If the results do not say it, it is not a finding. Never fill a gap with what you already believe about this market.',
    '- One or two sentences each. The source carries the detail.',
    '- Cite the URL you took it from.',
    '- Return fewer findings rather than padding. Three real ones beat eight invented ones.',
    '- If the results are off-topic or empty, return an empty array. That is a valid and useful answer.',
    '',
    'Return ONLY this JSON: {"findings":[{"finding":"...","source":"<url>"}]}',
  ].join('\n');

  const body = hits
    .slice(0, 10)
    .map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.snippet}`)
    .join('\n\n');

  try {
    const raw = await generateChat({
      system,
      messages: [{ role: 'user', content: `Results:\n\n${body}\n\nDistil them now.` }],
      temperature: 0.2,
      accountId,
      task: 'extract',
    });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]);
    const list = Array.isArray(parsed?.findings) ? parsed.findings : [];
    return list
      .filter((f: any) => typeof f?.finding === 'string' && f.finding.trim())
      .slice(0, 8)
      .map((f: any) => ({
        pass,
        finding: String(f.finding).trim().slice(0, 600),
        source: typeof f.source === 'string' ? f.source.slice(0, 500) : null,
        sourceKind: 'web',
        detail: {},
      }));
  } catch {
    return [];
  }
}

/** Run one pass end to end. Never throws — a failed pass is a gap, not an
 *  exception, because one dead search engine must not lose the other three. */
async function runPass(
  accountId: string,
  pass: ResearchPass,
  subject: string,
  competitors: string[],
): Promise<{ findings: ResearchFinding[]; gap?: string }> {
  try {
    const queries = queriesFor(pass, subject, competitors);
    const results = await Promise.all(
      queries.map((q) => webSearch(q, 5).catch(() => null)),
    );
    const hits = results
      .filter(Boolean)
      .flatMap((r: any) => (Array.isArray(r.results) ? r.results : []));
    if (!hits.length) {
      return { findings: [], gap: 'no usable search results came back' };
    }
    const findings = await distil(accountId, pass, subject, hits);
    if (!findings.length) {
      return { findings: [], gap: 'the results did not support any finding worth keeping' };
    }
    return { findings };
  } catch (e: any) {
    return { findings: [], gap: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * The four-pass sweep.
 *
 * Passes run concurrently because they are independent, and the whole point of
 * a sweep is that it finishes inside one conversation rather than four.
 */
export async function runResearchSweep(input: {
  accountId: string;
  brandId?: string | null;
  subject: string;
  competitors?: string[];
  passes?: ResearchPass[];
}): Promise<SweepResult> {
  const passes = input.passes?.length ? input.passes : RESEARCH_PASSES;
  const competitors = input.competitors ?? [];

  const results = await Promise.all(
    passes.map((p) => runPass(input.accountId, p, input.subject, competitors)),
  );

  const findings: ResearchFinding[] = [];
  const gaps: { pass: ResearchPass; reason: string }[] = [];
  results.forEach((r, i) => {
    findings.push(...r.findings);
    if (r.gap) gaps.push({ pass: passes[i], reason: r.gap });
  });

  if (findings.length && dbReady()) {
    await storeFindings(input.accountId, input.brandId ?? null, findings).catch(() => {});
  }
  return { findings, gaps };
}

/**
 * Persist findings, superseding the previous generation for the same passes.
 *
 * Supersession rather than deletion: a competitor's old positioning was true
 * when captured, and overwriting it means "what did we believe in March" stops
 * being answerable. Only the passes that actually produced findings are
 * superseded — a pass that failed must not wipe the last good sweep.
 */
export async function storeFindings(
  accountId: string,
  brandId: string | null,
  findings: ResearchFinding[],
): Promise<void> {
  const passes = Array.from(new Set(findings.map((f) => f.pass)));
  if (!passes.length) return;

  let sup = supabase
    .from('research_findings')
    .update({ superseded_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .in('pass', passes)
    .is('superseded_at', null);
  sup = brandId ? sup.eq('brand_id', brandId) : sup.is('brand_id', null);
  await sup;

  await supabase.from('research_findings').insert(
    findings.map((f) => ({
      account_id: accountId,
      brand_id: brandId,
      pass: f.pass,
      finding: f.finding,
      source: f.source ?? null,
      source_kind: f.sourceKind ?? null,
      detail: f.detail ?? {},
    })),
  );
}

/** Current findings for a brand, newest first. */
export async function listFindings(
  accountId: string,
  brandId?: string | null,
  pass?: ResearchPass,
): Promise<any[]> {
  if (!dbReady()) return [];
  let q = supabase
    .from('research_findings')
    .select('id, pass, finding, source, created_at')
    .eq('account_id', accountId)
    .is('superseded_at', null);
  if (brandId) q = q.eq('brand_id', brandId);
  if (pass) q = q.eq('pass', pass);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(80);
  if (error) throw error;
  return data || [];
}

/** Render the vault as a grounding block for a later prompt. */
export function researchBlock(findings: { pass: string; finding: string; source?: string | null }[]): string {
  if (!findings.length) return '';
  const byPass = new Map<string, string[]>();
  for (const f of findings) {
    if (!byPass.has(f.pass)) byPass.set(f.pass, []);
    byPass.get(f.pass)!.push(f.source ? `${f.finding} [${f.source}]` : f.finding);
  }
  const LABEL: Record<string, string> = {
    competitor: 'What competitors are saying',
    trend: 'What the platforms are rewarding',
    search: 'What people are searching for',
    audience: 'How the audience talks about it',
  };
  const lines = ['RESEARCH — findings on file for this venture. Use them; do not contradict them without saying so.'];
  for (const [pass, items] of byPass) {
    lines.push(`\n${LABEL[pass] || pass}:`);
    for (const i of items.slice(0, 8)) lines.push(`- ${i}`);
  }
  return lines.join('\n');
}
