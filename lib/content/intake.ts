// The front door — "here is what I'm building" becomes a grounded venture.
//
// THE GAP THIS CLOSES. Everything downstream of a brand kit existed: pillars,
// platform specs, the generator, the board, the linearity gate. Nothing filled
// the kit. A venture arrived empty and stayed empty until someone typed into
// six separate screens, which nobody does, so the engine ran ungrounded and
// produced content that could belong to anyone.
//
// WHY THIS LIVES IN THE ASSISTANT RATHER THAN A FORM. The research passes it
// triggers are already assistant capabilities, and the interesting part of an
// intake is the follow-up question — "you said 'agencies', do you mean the
// people buying or the people selling?" A form cannot ask that. What this
// module provides is the machinery the conversation drives: capture what was
// said, sweep, propose.
//
// THE ONE RULE THAT SHAPES THE DESIGN: the canon is PROPOSED, never saved
// automatically. A brand's core belief is not a fact to be extracted, it is a
// claim its owner has to recognise as theirs. A model that writes a thesis and
// stores it has invented the brand's convictions and then held all future
// content to them — the drift the canon exists to prevent, installed at the
// root where nobody would look for it.

import { supabase, dbReady } from '@/lib/db';
import { generateChat } from '@/lib/ai/router';
import { runResearchSweep, listFindings, researchBlock, type SweepResult } from './research';

export interface IntakeInput {
  accountId: string;
  brandId?: string | null;
  description: string;
  competitors?: string[];
  audience?: string;
  offer?: string;
}

/** Record what the operator said, verbatim.
 *
 *  raw_description is stored exactly as given and never rewritten. It is the
 *  only unmediated statement of intent in the pipeline — everything downstream
 *  is derived from it — so paraphrasing at the door would corrupt every later
 *  inference and leave no way to notice it had happened. */
export async function captureIntake(input: IntakeInput): Promise<{ id: string } | null> {
  if (!dbReady()) return null;
  const { data, error } = await supabase.from('brand_intakes').insert([{
    account_id: input.accountId,
    brand_id: input.brandId ?? null,
    raw_description: input.description,
    stated_competitors: input.competitors ?? [],
    stated_audience: input.audience ?? null,
    stated_offer: input.offer ?? null,
    status: 'captured',
  }]).select('id').single();
  if (error) throw error;
  return { id: data.id };
}

async function markIntake(accountId: string, intakeId: string, status: string): Promise<void> {
  await supabase.from('brand_intakes')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', intakeId).eq('account_id', accountId);
}

/** Capture, then sweep. One call, because a description with no research behind
 *  it is just a note, and research with nothing to attach it to is a search. */
export async function runIntake(input: IntakeInput): Promise<{
  intakeId: string | null;
  research: SweepResult;
}> {
  const intake = await captureIntake(input).catch(() => null);
  const research = await runResearchSweep({
    accountId: input.accountId,
    brandId: input.brandId,
    subject: input.description,
    competitors: input.competitors,
  });
  if (intake && research.findings.length) {
    await markIntake(input.accountId, intake.id, 'researched').catch(() => {});
  }
  return { intakeId: intake?.id ?? null, research };
}

export interface ProposedCanon {
  coreThesis: string;
  brandEnemy: string;
  anchorTakeaway: string;
  mandatoryLexicon: string[];
  bannedTerms: string[];
  pillars: { name: string; pain: string; promise: string }[];
  /** What the proposal rests on, so a human can judge it rather than accept it.
   *  A proposal that cannot say why is a guess wearing a suit. */
  rationale: string;
  /** Where the research was thin. Named explicitly because a canon built on two
   *  findings and a lot of confidence looks identical to one built on twenty. */
  caveats: string[];
}

const CANON_SYSTEM = [
  'You are proposing a brand canon — the fixed beliefs a brand asserts — from what its owner told you and what research found.',
  '',
  'The four things you are drafting:',
  '- coreThesis: the single non-negotiable claim. Not a description of the product; a claim about the world that the product follows from.',
  '- brandEnemy: the prevailing belief or broken status quo the brand argues against. Hooks are built by agitating this, so it must be something a real person actually believes.',
  '- anchorTakeaway: what someone concludes after seeing any piece of this brand\'s content, even with the logo removed.',
  '- bannedTerms: the generic marketing words that would dissolve this brand into every other one in its category. Pull from the clichés its competitors are already using.',
  '- mandatoryLexicon: words or phrases this brand should own. Prefer the audience\'s own vocabulary from the research over invented jargon.',
  '',
  'Also propose 3-5 content pillars: a name, the pain it speaks to, and the relief promised.',
  '',
  'HOW TO BE USEFUL HERE:',
  '- The thesis must be arguable. If no reasonable person would disagree, it is a platitude, not a position — "we care about quality" is not a thesis.',
  '- Ground it in what was actually said and found. You are drafting the owner\'s conviction back to them, not authoring one for them.',
  '- Where the research was thin, say so in caveats. Do not compensate with confidence.',
  '- Never invent a competitor, a statistic, or a customer quote.',
  '',
  'Return ONLY this JSON:',
  '{"coreThesis":"...","brandEnemy":"...","anchorTakeaway":"...","mandatoryLexicon":["..."],"bannedTerms":["..."],"pillars":[{"name":"...","pain":"...","promise":"..."}],"rationale":"...","caveats":["..."]}',
].join('\n');

/**
 * Draft a canon from the intake and the vault. Returns it; saves nothing.
 *
 * The caller shows this to the operator, who edits and confirms it through
 * setBrandCanon. That handoff is the whole safety property — see the header.
 */
export async function proposeCanon(input: {
  accountId: string;
  brandId?: string | null;
  description: string;
}): Promise<ProposedCanon | { error: string }> {
  const findings = await listFindings(input.accountId, input.brandId).catch(() => []);

  const userTurn = [
    `What the owner said they are building:\n${input.description}`,
    '',
    findings.length
      ? researchBlock(findings)
      : 'NO RESEARCH ON FILE. Draft from the description alone, and say plainly in caveats that this proposal has no research behind it.',
    '',
    'Draft the canon now.',
  ].join('\n');

  try {
    const raw = await generateChat({
      system: CANON_SYSTEM,
      messages: [{ role: 'user', content: userTurn }],
      temperature: 0.4,
      accountId: input.accountId,
      task: 'reason',
      preferTier: 'heavy',
    });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { error: 'Could not draft a canon from that — the model did not return a usable proposal.' };
    const p = JSON.parse(m[0]);
    if (!p?.coreThesis) return { error: 'The draft came back without a thesis, so there is nothing to propose.' };

    return {
      coreThesis: String(p.coreThesis).slice(0, 600),
      brandEnemy: String(p.brandEnemy || '').slice(0, 600),
      anchorTakeaway: String(p.anchorTakeaway || '').slice(0, 600),
      mandatoryLexicon: Array.isArray(p.mandatoryLexicon) ? p.mandatoryLexicon.map(String).slice(0, 20) : [],
      bannedTerms: Array.isArray(p.bannedTerms) ? p.bannedTerms.map(String).slice(0, 30) : [],
      pillars: Array.isArray(p.pillars)
        ? p.pillars.slice(0, 5).map((x: any) => ({
            name: String(x?.name || '').slice(0, 120),
            pain: String(x?.pain || '').slice(0, 400),
            promise: String(x?.promise || '').slice(0, 400),
          })).filter((x: any) => x.name)
        : [],
      rationale: String(p.rationale || '').slice(0, 1500),
      caveats: Array.isArray(p.caveats) ? p.caveats.map(String).slice(0, 8) : [],
    };
  } catch (e: any) {
    return { error: e?.message || 'Could not draft a canon.' };
  }
}
