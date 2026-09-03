// The extraction job — the ONLY writer to memory.
//
// Two properties this exists to hold.
//
// 1. IT IS NOT ON THE LIVE PATH. A turn writes its transcript and returns;
//    deciding what was durable happens later, with the finished exchange in
//    view. That is both a latency property and a quality one — mid-turn, the
//    model does not yet know whether the thing just said turned out to matter.
//    (`ingestCarryoverFacts` was already async, but it only fired on a
//    compaction event, so a short conversation that ended normally extracted
//    nothing at all. That is a large part of why agent_memory has zero rows in
//    production.)
//
// 2. IT IS THE ONLY WRITER. One place the tier rules live, one place the
//    exclusion list is enforced. The alternative — several call sites each
//    deciding what is worth remembering — is precisely the failure mode this
//    codebase has already produced twice: four provider clients each reporting
//    token usage differently, two agent loops each handling a JSON failure
//    differently.

import { BUDGET } from '@/lib/ai/context-budget';
import { supabase } from '@/lib/db';
import { log } from '@/lib/logger';
import { generateChat } from '@/lib/ai/router';
import { recordFact } from '@/lib/agent/memory';
import { writeEdge } from './edges';
import { projectSubjectWithRetry } from './project';
import { exclusionFor, tierFor, MAX_FACT_LENGTH } from './tiers';
import { isSubjectType, type CandidateFact, type FactDecision, type SubjectRef } from './types';

/** Conversations processed per tick. Bounded so one tick cannot run long enough
 *  to be killed mid-write by a serverless timeout. */
const BATCH_SIZE = Number(process.env.MEMORY_EXTRACT_BATCH) || 5;
/** Facts accepted from one conversation. A model asked for "durable facts" that
 *  returns forty has misunderstood the question. */
const MAX_FACTS_PER_CONVERSATION = 12;
/** Transcript characters handed to the extractor. The tail matters more than
 *  the head — decisions land at the end of a conversation. */
const TRANSCRIPT_CHARS = BUDGET.extractionChars;

const EXTRACTION_SYSTEM = [
  'You extract durable facts from a CRM/marketing conversation for long-term memory.',
  '',
  'Return ONLY a JSON object: {"facts":[{"subject_type":"...","subject_label":"...","predicate":"...","object":"...","fact":"..."}]}',
  'Return {"facts":[]} when nothing durable was said. That is a normal and frequent answer.',
  '',
  'subject_type is one of: contact, company, deal, campaign, segment, channel, creative_asset, brand, account.',
  'subject_label is the NAME as it appears in the conversation, so it can be matched to a record.',
  'predicate is a short snake_case relation. Prefer these where they fit:',
  '  has_role, works_at, reports_to, has_authority,',
  '  has_budget, has_timeline, has_contract_date, has_requirement, has_need, has_pain, raised_objection,',
  '  decided, committed_to, confirmed, rejected, signed,',
  '  brand_voice_rule, compliance_constraint, must_not_receive, achieved_metric, campaign_outcome,',
  '  prefers_channel, prefers_style, communication_style, sentiment, observed_pattern',
  'object is the value alone (e.g. "$65k", "VP Marketing", "Q3 2026").',
  'fact is one plain sentence a person could read.',
  '',
  'HARD RULES:',
  '- Record only what someone SAID or a system MEASURED. Never record your own read of anyone\'s intent, mood, or seriousness.',
  '- Never record a conclusion that was not itself stated. "Mentioned a tight budget" is a fact; "so they are not a real buyer" is not.',
  '- Never invent a cause for an outcome. A campaign\'s numbers are a fact; why it underperformed is a guess unless a person said it.',
  '- If a multi-point proposal was accepted with a general "sounds good", record the single confirmation — not each underlying point as if separately agreed.',
  '- Attribute each fact to the subject it is ABOUT, not to whichever record the conversation happened under.',
  '- Omit anything involving financial account numbers, health, government identifiers, protected attributes, or credentials. Do not substitute a placeholder — leave it out.',
].join('\n');

interface PendingConversation {
  id: string;
  accountId: string;
  brandId: string | null;
  transcript: any[];
}

/** Conversations with content the extractor has not yet seen. */
async function pending(limit: number): Promise<PendingConversation[]> {
  try {
    const { data, error } = await supabase
      .from('agent_conversations')
      .select('id, account_id, brand_id, transcript')
      .is('memory_extracted_at', null)
      .order('updated_at', { ascending: true })
      .limit(limit);
    if (error || !Array.isArray(data)) return [];
    return data.map((r: any) => ({
      id: r.id,
      accountId: r.account_id,
      brandId: r.brand_id ?? null,
      transcript: Array.isArray(r.transcript) ? r.transcript : [],
    }));
  } catch {
    return [];
  }
}

/** Flatten a transcript to the tail the extractor reads. OBSERVATION lines are
 *  kept — a tool result is where a measured outcome actually comes from. */
function renderTranscript(transcript: any[]): string {
  const lines = transcript
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`);
  const joined = lines.join('\n');
  return joined.length > TRANSCRIPT_CHARS ? joined.slice(-TRANSCRIPT_CHARS) : joined;
}

/**
 * `ok: true` iff `raw` actually parsed into a well-formed `{"facts":[...]}`
 * payload — including the empty array, which is a normal, well-formed answer
 * ("nothing durable was said"). `ok: false` covers everything the extractor
 * could not make sense of: no JSON object found, malformed JSON, or a
 * `facts` field that isn't an array.
 *
 * Split out from a single boolean on `facts.length === 0` (the original,
 * buggy shape of this check) because that count alone cannot tell "the model
 * validly reported nothing" from "the model said something the parser
 * couldn't read at all" — both have `facts.length === 0`. Only the second is
 * `parseFailed` in the summary log below.
 */
function parseFactsResult(raw: string): { facts: any[]; ok: boolean } {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { facts: [], ok: false };
  try {
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed?.facts) ? { facts: parsed.facts, ok: true } : { facts: [], ok: false };
  } catch {
    return { facts: [], ok: false };
  }
}

/**
 * Match an extracted subject label back to a real record.
 *
 * Abstains rather than guessing: an unmatched label yields null and the fact is
 * skipped. Writing a fact against a label the CRM does not recognise would
 * create a subject nobody can retrieve and quietly fork the graph.
 * `brand` resolves to the conversation's own brand_id, which is the one subject
 * the conversation already knows without matching.
 */
async function matchSubject(
  accountId: string,
  brandId: string | null,
  subjectType: string,
  label: string,
): Promise<SubjectRef | null> {
  if (!isSubjectType(subjectType)) return null;
  const name = (label || '').trim();

  if (subjectType === 'account') return { type: 'account', id: accountId, label: 'this account' };
  if (subjectType === 'brand') {
    return brandId ? { type: 'brand', id: brandId, label: name || undefined } : null;
  }
  if (!name) return null;

  const table = ({
    contact: 'contacts', company: 'companies', deal: 'deals',
    campaign: 'ad_campaigns', segment: 'segments',
  } as Record<string, string>)[subjectType];
  // channel / creative_asset / pattern have no backing table yet; they are
  // addressed by a stable slug rather than a row id.
  if (!table) {
    return { type: subjectType, id: name.toLowerCase().replace(/\s+/g, '-').slice(0, 80), label: name };
  }

  try {
    const { data } = await supabase
      .from(table).select('id, name').eq('account_id', accountId).ilike('name', name).limit(1);
    const row = Array.isArray(data) ? data[0] : null;
    return row ? { type: subjectType, id: (row as any).id, label: (row as any).name } : null;
  } catch {
    return null;
  }
}

/**
 * Decide and write one candidate. Exported for testing because this is the
 * function whose behaviour the calibration rules actually are — asserting on
 * the rules in isolation would repeat the mistake that let the token-accounting
 * bug survive a passing test suite.
 */
export async function decideAndWrite(
  accountId: string,
  candidate: CandidateFact,
  conversationId: string | null,
): Promise<FactDecision> {
  const fact = (candidate.fact || '').trim();
  if (!fact) return { candidate, outcome: 'skipped', rule: 'empty' };
  if (fact.length > MAX_FACT_LENGTH) {
    return { candidate, outcome: 'skipped', rule: 'too-long' };
  }

  const excluded = exclusionFor(candidate);
  if (excluded) return { candidate, outcome: 'skipped', rule: `excluded:${excluded}` };

  const verdict = tierFor(candidate);
  const res = await writeEdge({
    accountId,
    subject: candidate.subject,
    predicate: candidate.predicate,
    object: candidate.object,
    fact,
    tier: verdict.tier,
    conversationId,
    validFrom: candidate.validFrom,
  });

  if (res.outcome === 'failed') return { candidate, outcome: 'skipped', rule: 'write-failed' };

  // THE FIX (production defect: agent_memory had zero rows for the feature's
  // entire life). Everything above writes to the memory GRAPH (memory_edges /
  // memory_subjects, migration 061) — that landed, which is why those tables
  // were non-empty. It never wrote to `agent_memory`, the older flat durable-
  // facts table that `recallMemoryDigest` / `semanticRecall` / `listFacts` /
  // `forgetFact` all read. Nothing in this file called `recordFact`. Every fact
  // the extractor accepted was written to a table nothing downstream of those
  // four reads from, and dropped from agent_memory's point of view — silently,
  // because writeEdge succeeding looked identical to success from every log
  // line and every counter this job emits.
  //
  // Only on a genuinely NEW edge (`written`, not `recurrence`): agent_memory has
  // no occurrence-counting or supersession model, so recording every repeat
  // mention would just accumulate duplicate rows for one fact restated many
  // times — the same failure mode `writeEdge`'s recurrence branch exists to
  // avoid, one layer up. `recordFact` re-applies its own secret/length guard
  // independently (defense in depth: two call sites must NOT drift into only
  // one of them enforcing it), and is itself best-effort — a failure here must
  // not undo the edge already written, so it is swallowed, not surfaced as a
  // skip the caller would misread as "this fact was rejected".
  if (res.outcome === 'written') {
    try {
      await recordFact(accountId, {
        fact,
        subject: candidate.subject.label || candidate.subject.id,
        predicate: candidate.predicate,
        object: candidate.object,
      }, 'extraction');
    } catch { /* best-effort — the graph edge already written is the source of truth */ }
  }

  return {
    candidate,
    outcome: res.outcome === 'recurrence' ? 'recurrence' : 'written',
    tier: verdict.tier,
    rule: verdict.rule,
    edgeId: res.edgeId,
    supersededEdgeId: res.supersededEdgeId,
  };
}

export interface ExtractionSummary {
  conversations: number;
  written: number;
  recurrences: number;
  skipped: number;
  subjectsProjected: number;
}

/**
 * Process one conversation. Marks the watermark whatever happens — including on
 * a model failure — so a conversation the extractor cannot handle does not jam
 * the queue and starve every conversation behind it.
 */
async function extractOne(c: PendingConversation): Promise<Omit<ExtractionSummary, 'conversations'>> {
  const out = { written: 0, recurrences: 0, skipped: 0, subjectsProjected: 0 };
  const body = renderTranscript(c.transcript);

  if (body.trim()) {
    let raw = '';
    try {
      raw = await generateChat({
        system: EXTRACTION_SYSTEM,
        messages: [{ role: 'user', content: body }],
        temperature: 0.1,
        accountId: c.accountId,
        conversationId: c.id,
        task: 'reason',
      });
    } catch (e) {
      log.warn('memory: extraction model call failed', {
        accountId: c.accountId, conversationId: c.id, error: String((e as any)?.message || e),
      });
    }

    const parseResult = parseFactsResult(raw);
    const facts = parseResult.facts.slice(0, MAX_FACTS_PER_CONVERSATION);
    const decisions: FactDecision[] = [];
    const touched = new Map<string, SubjectRef>();

    for (const f of facts) {
      const subject = await matchSubject(c.accountId, c.brandId, String(f?.subject_type || ''), String(f?.subject_label || ''));
      if (!subject) {
        out.skipped++;
        decisions.push({
          candidate: {
            subject: { type: 'account', id: c.accountId },
            predicate: String(f?.predicate || ''), object: String(f?.object || ''), fact: String(f?.fact || ''),
          },
          outcome: 'skipped',
          rule: `unresolved-subject:${f?.subject_type || '?'}`,
        });
        continue;
      }
      const candidate: CandidateFact = {
        subject,
        predicate: String(f?.predicate || 'stated').toLowerCase().trim(),
        object: String(f?.object || '').trim(),
        fact: String(f?.fact || '').trim(),
      };
      const d = await decideAndWrite(c.accountId, candidate, c.id);
      decisions.push(d);
      if (d.outcome === 'written') { out.written++; touched.set(`${subject.type}:${subject.id}`, subject); }
      else if (d.outcome === 'recurrence') { out.recurrences++; touched.set(`${subject.type}:${subject.id}`, subject); }
      else out.skipped++;
    }

    // WHAT WAS CONSIDERED AND SKIPPED, not just what was written. A threshold
    // that can only be observed through its successes cannot be tuned.
    //
    // PERSISTED, not console-only. `log.info` (what this used to call) never
    // reaches `app_logs` — see lib/logger.ts and the comments in
    // lib/agent/loop.ts / app/api/agent/stream/route.ts about `log.request`
    // being the only persisted channel. That is half of why a production probe
    // could see three successful model calls and 23 memory_edges rows with
    // nothing explaining why agent_memory stayed at zero: the one line that
    // would have said "written 12, skipped 8, rules: unresolved-subject…" was
    // never durable. Per-decision detail (predicate/subject text) is
    // deliberately left OUT of this persisted row — only counts, so the row
    // stays bounded regardless of how many facts a conversation produces.
    //
    // EMITTED WHENEVER THE MODEL CALL WAS ATTEMPTED (unconditional on
    // decisions.length, gated only by the enclosing `body.trim()`) — NOT only
    // when there was at least one decision. A model reply that parses to zero
    // facts, or a raw response the parser can't make sense of at all
    // (parseFailed), is exactly the case this exists to surface: it used to
    // emit nothing, which reads identically to "the conversation had nothing
    // durable to report" when it can just as easily mean "the model's output
    // was garbage and nobody could tell."
    {
      const rules: Record<string, number> = {};
      for (const d of decisions) rules[d.rule] = (rules[d.rule] || 0) + 1;
      const parseFailed = raw.trim().length > 0 && !parseResult.ok;
      log.request(
        {
          route: 'memory:extract',
          method: 'TICK',
          accountId: c.accountId,
          message: 'memory: extraction summary',
          detail: {
            conversationId: c.id,
            promptChars: body.length,
            facts: facts.length,
            written: out.written,
            recurrences: out.recurrences,
            skipped: out.skipped,
            rules,
            parseFailed,
          },
        },
        (out.written === 0 && facts.length > 0) || parseFailed ? 'warn' : 'info',
      );
    }

    for (const subject of touched.values()) {
      const p = await projectSubjectWithRetry(c.accountId, subject);
      if (p.ok) out.subjectsProjected++;
    }
  }

  try {
    await supabase
      .from('agent_conversations')
      .update({ memory_extracted_at: new Date().toISOString() })
      .eq('id', c.id);
  } catch { /* the next tick will retry this conversation */ }

  return out;
}

/**
 * One extraction tick. Called from the existing scheduled-task surface
 * (app/api/hermes/tick) — no new infrastructure, and no cron that can silently
 * stop without anything noticing.
 */
export async function runMemoryExtraction(limit = BATCH_SIZE): Promise<ExtractionSummary> {
  const summary: ExtractionSummary = {
    conversations: 0, written: 0, recurrences: 0, skipped: 0, subjectsProjected: 0,
  };
  const batch = await pending(limit);
  for (const c of batch) {
    const r = await extractOne(c);
    summary.conversations++;
    summary.written += r.written;
    summary.recurrences += r.recurrences;
    summary.skipped += r.skipped;
    summary.subjectsProjected += r.subjectsProjected;
  }
  if (summary.conversations) log.info('memory: extraction tick', { ...summary });
  return summary;
}
