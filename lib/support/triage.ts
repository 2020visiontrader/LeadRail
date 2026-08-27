// The agents that move a ticket across the board.
//
// FOUR STAGES, AND ONLY TWO OF THEM ARE MODELS. That split is the design, not
// an economy measure:
//
//   1. WATCHER      deterministic. Scans app_logs, fingerprints, dedupes, files
//                   at `triage`. No model, because this runs over every failure
//                   the platform produces and a model in that path is both
//                   expensive and a new way to be wrong about arithmetic.
//
//   2. DIAGNOSTICIAN  a model. triage → diagnosed. Reads the failure, its
//                   frequency, its shape and its route, and says what is
//                   actually broken. This is genuine judgement, which is what a
//                   model is for.
//
//   3. FIXER        a model. diagnosed → proposed. Writes a concrete change and
//                   classifies how confident it is. PROPOSES ONLY.
//
//   4. VERIFIER     deterministic, and emphatically not a model — it lives in
//                   tickets.ts. Asking a model "did the fix work?" reliably
//                   produces yes: it has the fix in front of it and no way to
//                   observe production. The only honest answer is whether the
//                   fingerprint fired again, which is a count.
//
// THE MISSING STAGE IS A PERSON. Nothing here moves a ticket to `accepted`.
// The transition is not merely discouraged in a prompt — tickets.ts refuses it
// for a non-human actor, because a rule enforced only by instructions is a rule
// that holds until the model has a bad day.
//
// WHY NOT AUTO-APPLY, given that is what was asked for. The tempting version
// writes the patch and ships it. Consider what that system does with the
// webhook incident in this platform's own history: 5,476 signature rejections
// whose real cause was a missing environment variable. A confident auto-fixer
// looking at "401 invalid signature" from inside the app would reach for the
// signature check — the code that was working correctly — and disable the thing
// protecting the endpoint. It would then observe the errors stop and report
// success. Auto-repair is not one capability, it is a diagnosis multiplied by a
// blast radius, and this stage cannot see the half that matters.

import { supabase, dbReady } from '@/lib/db';
import { generateChat } from '@/lib/ai/router';
import {
  fileFailure, attachAssessment,
  // This whole module is the triage BACKGROUND JOB (see the file banner
  // above): it runs on a schedule with no session and no single account to
  // scope to, and its purpose is to triage every open failure across the
  // whole platform, not one tenant's. That is a genuinely different thing
  // from a signed-in owner reading their own account's tickets, so it uses
  // the explicit System*Wide functions rather than a fabricated accountId or
  // a permissive default — see the comments on listTicketsSystemWide,
  // getTicketSystemWide and moveTicketSystemWide in ./tickets.
  getTicketSystemWide, moveTicketSystemWide, listTicketsSystemWide,
} from './tickets';

/** Statuses worth filing. 401/403/404 are excluded by default: on a public
 *  surface they are mostly the app correctly refusing something, and a board
 *  that fills with correct refusals stops being read. They are picked up by
 *  volume instead — see SUSPICIOUS_VOLUME. */
const ALWAYS_FILE = (s: number | null) => typeof s === 'number' && s >= 500;

/** …but a "correct refusal" happening hundreds of times is not a refusal, it is
 *  a symptom. This is exactly the webhook case: every individual 401 was the
 *  signature check working, and the aggregate was real events being dropped. */
const SUSPICIOUS_VOLUME = 50;

export interface SweepResult {
  scanned: number;
  created: number;
  merged: number;
  regressed: number;
}

/**
 * The watcher. Turn recent failures into tickets.
 *
 * Deliberately dumb and deliberately cheap: it decides WHAT deserves a card,
 * never what the card means. Every judgement is left to the diagnostician, so
 * this can run often without cost and without a model's opinion in the way.
 */
export async function sweepLogs(sinceMinutes = 60): Promise<SweepResult> {
  if (!dbReady()) return { scanned: 0, created: 0, merged: 0, regressed: 0 };
  const since = new Date(Date.now() - sinceMinutes * 60_000).toISOString();

  const { data: rows, error } = await supabase
    .from('app_logs')
    .select('id, route, status, message, detail, account_id, level')
    .gte('created_at', since)
    .in('level', ['error', 'warn'])
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) throw error;

  // Count by route+status first, so the volume rule can see an aggregate that
  // no single row reveals.
  const volume = new Map<string, number>();
  for (const r of rows || []) {
    const k = `${r.route}|${r.status}`;
    volume.set(k, (volume.get(k) || 0) + 1);
  }

  const out: SweepResult = { scanned: (rows || []).length, created: 0, merged: 0, regressed: 0 };
  const seenThisSweep = new Set<string>();

  for (const r of rows || []) {
    const key = `${r.route}|${r.status}`;
    const worth = ALWAYS_FILE(r.status) || (volume.get(key) || 0) >= SUSPICIOUS_VOLUME;
    if (!worth) continue;
    // One filing per distinct shape per sweep. The row count still lands, via
    // occurrences, on the ticket the first one created.
    if (seenThisSweep.has(key + r.message)) continue;
    seenThisSweep.add(key + r.message);

    const res = await fileFailure({
      accountId: r.account_id,
      shape: { route: r.route, statusCode: r.status, message: r.message || 'no message' },
      detail: typeof r.detail === 'object' ? JSON.stringify(r.detail).slice(0, 4000) : String(r.detail ?? ''),
      logId: r.id,
      severity: ALWAYS_FILE(r.status) ? 'high' : 'normal',
    }).catch(() => null);

    if (!res) continue;
    if (res.created) out.created++; else out.merged++;
    if (res.regressed) out.regressed++;
  }
  return out;
}

// ---------------------------------------------------------------------------

const DIAGNOSE_SYSTEM = [
  'You are triaging a production failure in LeadRail, a Next.js + Supabase B2B growth console.',
  '',
  'Say what is actually broken, from the evidence given. You have the error, the route, how often it',
  'fired, and over what period. You do NOT have the source code, the deploy history, or the',
  'environment — so a diagnosis that depends on any of those is a hypothesis, and must be labelled one.',
  '',
  'Classify fixability as exactly one of:',
  '- config:   a setting, environment variable or credential is missing or wrong. The commonest real cause.',
  '- code:     the application logic is wrong.',
  '- external: a third party is failing, rate-limiting, or has changed behaviour. Not ours to fix.',
  '- expected: the system is correctly refusing something. A 401 before authorization completes is not a bug.',
  '- unknown:  the evidence does not support a conclusion. Use this rather than picking the most plausible story.',
  '',
  'HOW TO BE USEFUL:',
  '- Frequency is evidence. Something firing 5,000 times is systematic; three times is probably a user doing something odd.',
  '- A high count of a "correct refusal" is not a refusal, it is a symptom. Look past the status code to what is being refused and why every time.',
  '- Prefer the boring explanation. Missing config outnumbers subtle logic bugs by a wide margin in practice.',
  '- Never invent a file, a line number, or a stack frame you were not shown.',
  '',
  'Return ONLY this JSON:',
  '{"diagnosis":"2-4 sentences","fixability":"config|code|external|expected|unknown","confidence":"low|moderate|high"}',
].join('\n');

/** The diagnostician. triage → diagnosed, or straight to wont_fix when the
 *  system was behaving correctly all along. */
export async function diagnoseTicket(ticketId: string, accountId?: string): Promise<{ ok: boolean; note: string }> {
  // Unscoped read: this is the platform job diagnosing a platform failure,
  // not a user reading another tenant's data. `accountId` here (used below
  // for generateChat's billing/routing) is unrelated to ticket visibility.
  const found = await getTicketSystemWide(ticketId);
  if (!found) return { ok: false, note: 'No such ticket.' };
  const t = found.ticket;

  const windowHours = Math.max(1,
    (new Date(t.last_seen).getTime() - new Date(t.first_seen).getTime()) / 3_600_000);

  const evidence = [
    `Title: ${t.title}`,
    `Route: ${t.route || 'unknown'}`,
    `HTTP status: ${t.status_code ?? 'n/a'}`,
    `Occurrences: ${t.occurrences} over ${Math.round(windowHours)}h (first seen ${t.first_seen}, last ${t.last_seen})`,
    '',
    'Error as recorded:',
    (t.detail || '').slice(0, 3000),
  ].join('\n');

  try {
    const raw = await generateChat({
      system: DIAGNOSE_SYSTEM,
      messages: [{ role: 'user', content: evidence }],
      temperature: 0.2,
      accountId: accountId || undefined,
      task: 'reason',
      preferTier: 'heavy',
    });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, note: 'The diagnosis did not come back in a usable form.' };
    const p = JSON.parse(m[0]);

    await attachAssessment({
      id: ticketId, actor: 'agent',
      diagnosis: String(p.diagnosis || '').slice(0, 2000),
      fixability: ['config', 'code', 'external', 'expected', 'unknown'].includes(p.fixability) ? p.fixability : 'unknown',
      confidence: ['low', 'moderate', 'high'].includes(p.confidence) ? p.confidence : 'low',
    });

    // "Expected" means the system was right. Closing it here is the difference
    // between a board that stays readable and one that drowns in its own
    // correct behaviour.
    const to = p.fixability === 'expected' ? 'wont_fix' : 'diagnosed';
    await moveTicketSystemWide({
      id: ticketId, to, actor: 'agent',
      note: p.fixability === 'expected' ? 'Diagnosed as expected behaviour, not a fault.' : undefined,
      resolution: p.fixability === 'expected' ? String(p.diagnosis || '').slice(0, 500) : undefined,
    });
    return { ok: true, note: `Diagnosed as ${p.fixability}.` };
  } catch (e: any) {
    return { ok: false, note: String(e?.message || e).slice(0, 200) };
  }
}

const PROPOSE_SYSTEM = [
  'You are proposing a fix for a diagnosed production failure. A person will read it and decide.',
  '',
  'WHAT YOU ARE WRITING is a recommendation, not a patch that will be applied. Nothing in this system',
  'executes what you write. Write for the engineer who has to judge it.',
  '',
  'Include, in this order:',
  '1. The change itself, specifically. "Set APP_BASE_URL to the deployment origin" beats "fix the config".',
  '2. Where it is made — an env var on the host, a specific route file, a provider dashboard.',
  '3. How to tell it worked, phrased as an observation rather than an assertion. This ticket will be',
  '   verified by watching whether the failure recurs, so say what should stop happening.',
  '4. What it might break. If nothing, say so plainly; if you cannot tell, say that instead of guessing.',
  '',
  'CONFIDENCE IS PART OF THE PROPOSAL, and understating it is much cheaper than overstating it:',
  '- high:     the evidence points at one cause and the change is reversible.',
  '- moderate: the cause is likely but the change touches behaviour beyond the failure.',
  '- low:      plausible, unproven. Say what would confirm it before anyone acts.',
  '',
  'Never propose disabling a check, a validation, or an error in order to stop the error appearing.',
  'That silences the symptom and keeps the fault, and on a security control it converts a loud',
  'failure into a quiet vulnerability.',
  '',
  'Return ONLY this JSON: {"fix":"...","confidence":"low|moderate|high"}',
].join('\n');

/** The fixer. diagnosed → proposed. Proposes; never applies. */
export async function proposeFix(ticketId: string, accountId?: string): Promise<{ ok: boolean; note: string }> {
  // Unscoped read — see diagnoseTicket above for why: this job triages
  // platform failures, not one tenant's data.
  const found = await getTicketSystemWide(ticketId);
  if (!found) return { ok: false, note: 'No such ticket.' };
  const t = found.ticket;
  if (!t.diagnosis) return { ok: false, note: 'Diagnose it first — a fix proposed without one is a guess.' };

  const brief = [
    `Failure: ${t.title}`,
    `Route: ${t.route || 'unknown'} · status ${t.status_code ?? 'n/a'} · ${t.occurrences} occurrences`,
    `Diagnosis (${t.fixability}, ${t.confidence} confidence): ${t.diagnosis}`,
    '',
    'Error as recorded:',
    (t.detail || '').slice(0, 2000),
  ].join('\n');

  try {
    const raw = await generateChat({
      system: PROPOSE_SYSTEM,
      messages: [{ role: 'user', content: brief }],
      temperature: 0.3,
      accountId: accountId || undefined,
      task: 'reason',
      preferTier: 'heavy',
    });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, note: 'The proposal did not come back in a usable form.' };
    const p = JSON.parse(m[0]);
    if (!p?.fix) return { ok: false, note: 'No fix was proposed.' };

    await attachAssessment({
      id: ticketId, actor: 'agent',
      proposedFix: String(p.fix).slice(0, 4000),
      confidence: ['low', 'moderate', 'high'].includes(p.confidence) ? p.confidence : 'low',
    });
    await moveTicketSystemWide({ id: ticketId, to: 'proposed', actor: 'agent' });
    return { ok: true, note: 'A fix is proposed and waiting for a decision.' };
  } catch (e: any) {
    return { ok: false, note: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Run the machine-owned half of the board: sweep, then diagnose and propose
 * for anything sitting in the columns an agent owns.
 *
 * Bounded per run on purpose. An unbounded pass over a fresh backlog would be
 * hundreds of model calls triggered by an incident — turning a bad hour into an
 * expensive one, at exactly the moment nobody is watching spend.
 */
export async function runTriageCycle(opts?: { accountId?: string; maxPerStage?: number }): Promise<{
  sweep: SweepResult; diagnosed: number; proposed: number; notes: string[];
}> {
  const cap = opts?.maxPerStage ?? 5;
  const notes: string[] = [];
  const sweep = await sweepLogs();

  let diagnosed = 0;
  // System-wide sweep of the columns an agent owns — see the import comment
  // above for why this job legitimately reads across every tenant.
  for (const t of (await listTicketsSystemWide({ status: 'triage', limit: cap }))) {
    const r = await diagnoseTicket(t.id, opts?.accountId);
    if (r.ok) diagnosed++; else notes.push(`${t.title}: ${r.note}`);
  }

  let proposed = 0;
  for (const t of (await listTicketsSystemWide({ status: 'diagnosed', limit: cap }))) {
    // External and expected causes get no proposal — there is nothing for us
    // to change, and inventing one anyway is how a board fills with work that
    // cannot be done.
    if (t.fixability === 'external' || t.fixability === 'expected') continue;
    const r = await proposeFix(t.id, opts?.accountId);
    if (r.ok) proposed++; else notes.push(`${t.title}: ${r.note}`);
  }

  return { sweep, diagnosed, proposed, notes };
}
