import { z } from 'zod';
import { violatesWhiteLabel } from '@/lib/ai/marketing';
import { generateChat } from '@/lib/ai/router';
import { loadVentureContext } from '@/lib/ai/venture-context';
import { getVenture, getVentures } from '@/lib/db';
import { obj, S, type Capability } from './types';

// Content quality gate.
//
// The approvals layer gates SPEND and SIDE EFFECTS — it asks "do you want to pay
// for this / send this to a real person". Nothing gated QUALITY, so the assistant
// could draft weak copy and the only checkpoint was cost. This is the missing
// axis: a verdict on the writing itself, before it reaches anyone.
//
// Borrowed from the kai-cmo-harness pattern, and the rule that makes it work is
// the separation of powers: THE ACTOR MAY SUBMIT EVIDENCE, THE ACTOR MAY NOT
// ISSUE ITS OWN VERDICT. The thing that wrote the copy does not get to decide
// whether the copy is good. So this is a distinct capability the model must call,
// producing a PASS/FAIL naming the specific failing rule — never a vague score
// the model can talk its way past.
//
// Deliberately mechanical: every check below is a regex or a string test. That
// makes the verdict reproducible, citable by line, and — the reason it matters
// today — it works with the entire model ladder down.

interface Finding {
  rule: string;
  severity: 'fail' | 'warn';
  detail: string;
  found: string[];
}

// Phrases that mark text as machine-written to a reader who has seen a lot of it.
// Each is a whole phrase, not a word, so ordinary prose does not trip them.
const AI_TELLS = [
  'i hope this finds you well', 'i hope this email finds you well',
  'delighted to', 'thrilled to', 'excited to announce',
  'in today’s fast-paced', 'in today\'s fast-paced',
  'game-changer', 'game changer', 'revolutionize', 'revolutionise',
  'unlock the power', 'take it to the next level', 'seamlessly integrate',
  'at the end of the day,', 'it is important to note that',
  'delve into', 'navigate the complexities', 'in the ever-evolving',
];

// Unsupported absolutes. A claim like "the best" cannot be defended in outreach
// and is the kind of thing that gets a sender reported rather than replied to.
const UNSUPPORTED_CLAIMS = [
  'guaranteed', 'the best', '#1 ', 'number one', 'world-class', 'industry-leading',
  'never fails', '100% ', 'risk-free', 'instantly',
];

const HYPE_ADJECTIVES = ['amazing', 'incredible', 'stunning', 'insane', 'unbelievable', 'massive'];

function findAll(haystack: string, needles: string[]): string[] {
  const lower = haystack.toLowerCase();
  return needles.filter((n) => lower.includes(n.toLowerCase()));
}

export const QUALITY_CAPABILITIES: Capability[] = [
  {
    name: 'reviewContent',
    domain: 'quality',
    title: 'Review content against the quality gate',
    description:
      'Judge a piece of drafted copy before it is sent or published. Returns PASS or FAIL naming the exact failing rule, plus every AI tell, unsupported claim and banned term located verbatim. Call this on any draft that will reach a real person — you may NOT pass your own work; this is a separate verdict.',
    gate: 'read',
    inputSchema: obj({ text: S.string, kind: S.string }, ['text']),
    zod: z.object({
      text: z.string().min(1),
      // Thresholds differ by format: an email that runs long gets ignored, a
      // social post that runs long gets truncated by the platform.
      kind: z.enum(['email', 'social', 'ad', 'other']).optional(),
    }),
    run: async (_accountId, a) => {
      const text = String(a.text);
      const kind = a.kind || 'other';
      const findings: Finding[] = [];

      const tells = findAll(text, AI_TELLS);
      if (tells.length) {
        findings.push({
          rule: 'ai-tells', severity: 'fail', found: tells,
          detail: 'Phrases that read as machine-written. Cut or rewrite each one.',
        });
      }

      const claims = findAll(text, UNSUPPORTED_CLAIMS);
      if (claims.length) {
        findings.push({
          rule: 'unsupported-claims', severity: 'fail', found: claims,
          detail: 'Absolute claims you cannot defend. Replace with something specific and true.',
        });
      }

      const banned = violatesWhiteLabel(text);
      if (banned.length) {
        findings.push({
          rule: 'white-label', severity: 'fail', found: banned,
          detail: 'Names the underlying tooling. Client-facing copy must never disclose the stack.',
        });
      }

      const hype = findAll(text, HYPE_ADJECTIVES);
      if (hype.length) {
        findings.push({
          rule: 'hype-adjectives', severity: 'warn', found: hype,
          detail: 'Hype adjectives weaken a claim rather than strengthen it.',
        });
      }

      const words = text.trim().split(/\s+/).filter(Boolean).length;
      const LIMITS: Record<string, number> = { email: 120, social: 60, ad: 40, other: 400 };
      if (words > LIMITS[kind]) {
        findings.push({
          rule: 'length', severity: 'warn', found: [`${words} words`],
          detail: `Over the ${LIMITS[kind]}-word ceiling for ${kind}. Longer copy is read less, not more.`,
        });
      }

      // Exactly one ask. Multiple questions split the reader's attention and
      // reliably lower reply rates on outreach.
      if (kind === 'email') {
        const questions = (text.match(/\?/g) || []).length;
        if (questions > 1) {
          findings.push({
            rule: 'single-ask', severity: 'warn', found: [`${questions} questions`],
            detail: 'More than one ask. Pick the single question you most want answered.',
          });
        }
      }

      const fails = findings.filter((f) => f.severity === 'fail');
      return {
        verdict: fails.length ? 'FAIL' : 'PASS',
        // The failing RULE, never a score — a number invites negotiation, a named
        // rule tells the writer exactly what to change.
        failedRules: fails.map((f) => f.rule),
        findings,
        wordCount: words,
        checkedAs: kind,
      };
    },
    digest: (_a, result: any) => {
      if (!result) return '';
      if (result.verdict === 'PASS') {
        const warns = (result.findings || []).filter((f: any) => f.severity === 'warn').length;
        return warns ? `PASS with ${warns} warning${warns === 1 ? '' : 's'}.` : 'PASS — no issues found.';
      }
      return `FAIL — ${(result.failedRules || []).join(', ')}.`;
    },
  },
  {
    name: 'judgeVoice',
    domain: 'quality',
    title: 'Judge copy on voice and substance',
    description:
      'A subjective editorial review of drafted copy: does it sound like this brand, does it earn its claims, does it open well. Run this AFTER reviewContent passes — mechanical rules first, judgment only on what survives them. Returns severity-ranked issues quoting the offending line, plus a rewrite of the weakest sentence.',
    gate: 'read',
    inputSchema: obj({ text: S.string, brandId: S.string, kind: S.string }, ['text']),
    zod: z.object({ text: z.string().min(1), brandId: z.string().optional(), kind: z.string().optional() }),
    run: async (accountId, a) => {
      const v: any = a.brandId ? await getVenture(a.brandId) : (await getVentures(accountId))[0];
      if (v?.account_id && v.account_id !== accountId) return { error: 'Brand not found' };
      const ctx = v ? await loadVentureContext(v.id, accountId) : undefined;

      const voice = [
        ctx?.name && `Brand: ${ctx.name}`,
        ctx?.description && `What it does: ${ctx.description}`,
        ctx?.pitch && `Pitch: ${ctx.pitch}`,
        v?.tone && `Tone: ${v.tone}`,
      ].filter(Boolean).join('\n');

      const raw = await generateChat({
        // The judge is told it is NOT the author. Without that framing a model
        // asked to review copy tends to praise it — the same instinct that makes
        // self-review worthless is what this separation exists to defeat.
        system: [
          'You are a line editor reviewing someone ELSE\'s draft. You did not write it and you gain nothing from it being good.',
          'Quote the exact text you are objecting to. An objection without a quote is not actionable.',
          'Rank by severity. If the copy is genuinely fine, say so in one line rather than inventing issues.',
        ].join(' '),
        messages: [{
          role: 'user',
          content: [
            voice ? `BRAND VOICE:\n${voice}\n` : 'No stored brand voice — judge on general craft only, and say that.',
            `FORMAT: ${a.kind || 'unspecified'}`,
            '',
            'DRAFT:',
            String(a.text),
            '',
            'Respond with ONLY this JSON:',
            '{"verdict":"strong|acceptable|weak","issues":[{"severity":"high|medium|low","quote":"the exact offending text","problem":"...","fix":"..."}],"weakestSentence":"...","rewrite":"your rewrite of that one sentence"}',
          ].join('\n'),
        }],
        temperature: 0.3,
        // No explicit cap: an editorial review quotes the offending lines, so
        // its length scales with the draft under review.
      });

      const cleaned = String(raw).replace(/```json|```/g, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start === -1 || end <= start) return { review: cleaned };
      try { return JSON.parse(cleaned.slice(start, end + 1)); }
      catch { return { review: cleaned }; }
    },
    digest: (_a, result: any) => {
      if (!result || result.review) return 'Reviewed the copy.';
      const issues = Array.isArray(result.issues) ? result.issues : [];
      const high = issues.filter((i: any) => i.severity === 'high').length;
      return [
        `Verdict: ${result.verdict || 'unclear'}.`,
        issues.length ? `${issues.length} issue${issues.length === 1 ? '' : 's'}${high ? `, ${high} high` : ''}.` : 'No issues raised.',
      ].join(' ');
    },
  },
];
