// Skill content screening.
//
// WHY THIS IS NOT OPTIONAL. A skill's `instructions` are spliced verbatim into
// the agent's SYSTEM prompt — the most trusted position in the whole context,
// above the user's own message. The catalog is 353 skills, 341 of them
// harvested from third-party open-source repositories. Nothing read that text
// before it reached the model.
//
// That is a prompt-injection surface with a very short path: land a line in
// any harvested SKILL.md, wait for an account to enable it, and from then on
// every turn on that account carries your instruction at system level. The
// harvest is a one-time snapshot, so a compromise upstream does not even need
// to reach us live — it needed to be in the file on the day we scanned.
//
// WHAT THIS DOES AND DOES NOT CLAIM. This is a screen, not a sandbox. It
// cannot decide whether prose is malicious; what it can do is refuse the
// shapes that have no legitimate reason to appear in marketing guidance —
// instructions addressed at the agent's own rules rather than at the work.
// A skill that says "write in short sentences" passes. A skill that says
// "ignore your previous instructions" does not, and a human should look at why
// a copywriting skill wanted to say that.
//
// Findings are SEVERITY-RANKED rather than pass/fail because the two classes
// behave differently: 'block' keeps the text out of the prompt entirely, while
// 'flag' lets it through and records it, so a false positive degrades to a log
// line instead of silently removing a skill someone depends on.
//
// CALIBRATED AGAINST THE LIVE CATALOG, and the first draft was badly wrong: it
// would have blocked 93 of 443 skills. Not one was an attack. They were
// setup guides mentioning "API key", workflow notes saying "proceed without
// asking", automation skills describing "post to a webhook" — topic words, not
// instructions. A screen that removes a fifth of the catalog gets switched off,
// and then it protects nothing.
//
// So every 'block' rule below keys on the ACT, never the subject: not the word
// "credential" but reading or emitting one; not "without asking" but bypassing
// the approval gate; not "post to a webhook" but sending the conversation
// there. Anything that cannot be told apart from legitimate guidance by
// pattern alone is a 'flag', which surfaces it to a human instead of deciding.
//
// The second calibration pass moved two more rules from block to flag, for a
// reason worth stating plainly: pattern matching cannot read negation. Every
// live 'approval-bypass' hit was a skill ENFORCING the rule — "Never
// auto-approve", "do not skip an approval" — and every 'exfiltration' hit was
// a privacy notice promising the opposite of what it matched. A negation guard
// (isNegated, below) now catches the common shape, but the residue is exactly
// why those two stayed advisory.
//
// The result against the live 443-skill catalog: ZERO blocked. That is the
// correct outcome and not a broken screen — the block rules are tripwires for
// shapes that have no innocent reading, and nothing in the catalog has one
// today. A screen whose value is measured in how much it removes will be tuned
// until it removes something.

export type SkillFindingSeverity = 'block' | 'flag';

export interface SkillFinding {
  severity: SkillFindingSeverity;
  rule: string;
  /** The matched text, clipped — enough to judge, never the whole skill. */
  excerpt: string;
}

export interface SkillScanResult {
  safe: boolean;
  findings: SkillFinding[];
}

interface Rule {
  id: string;
  severity: SkillFindingSeverity;
  pattern: RegExp;
}

// Ordered most-specific first so the reported rule is the informative one.
//
// Every pattern here targets an instruction aimed at the AGENT'S CONTRACT —
// its rules, its identity, its approval gate, its secrets — rather than at the
// marketing task a skill exists to shape. That distinction is the whole basis
// for calling any of this unsafe; a rule that cannot be justified by it does
// not belong in this list.
const RULES: Rule[] = [
  {
    // The canonical injection opener. Precise by construction: there is no
    // legitimate reason for marketing guidance to address the assistant's
    // prior instructions at all.
    id: 'override-instructions',
    severity: 'block',
    pattern: /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|your\s+|the\s+)?(previous|prior|earlier|above|preceding|system|initial)\s+(instruction|instructions|prompt|prompts|rule|rules|direction|directions)\b/i,
  },
  {
    // Credentials: the ACT of obtaining or emitting one, never the mention.
    //
    // Calibrated against the live catalog, where the first draft of this rule
    // matched 52 of 443 skills — every one of them a legitimate line like
    // "paste your API key into the connector". Mentioning a credential is what
    // a setup guide does; reading, printing or transmitting one is the attack,
    // so the verb is what the pattern keys on.
    id: 'credential-access',
    severity: 'block',
    // Narrowed twice. `process.env.SOMETHING_API_KEY` is how every API guide
    // in the catalog shows a request being made — three live skills matched on
    // exactly that, all of them code samples. Reading a key from the
    // environment is what correct code does; only being told to EMIT one is an
    // attack, so the verbs here are the ones that put a secret in front of
    // someone.
    pattern: /\b(reveal|leak|dump|exfiltrate|disclose)\b[^.\n]{0,40}\b(api[_\s-]?key|access[_\s-]?token|secret[_\s-]?key|client[_\s-]?secret|service[_\s-]?role\s+key|credential|password)\b/i,
  },
  {
    // The same subject one severity down: code that touches secrets, which is
    // ordinary in an integration guide and worth a glance in a copywriting one.
    id: 'credential-reference',
    severity: 'flag',
    pattern: /\bprocess\.env\b|\b(read|access|open)\b[^.\n]{0,20}\b(\.env|environment\s+variables?)\b/i,
  },
  {
    // The approval GATE, not the act of asking a question.
    //
    // Also calibrated: the first draft matched 44 skills on "without asking",
    // which in a marketing skill means "don't pester the user for input you
    // can infer" — the opposite of a safety concern. This one has to name the
    // machinery: approval, confirmation, the gate, the human in the loop.
    id: 'approval-bypass',
    // FLAGGED, not blocked, and the live catalog is why. All five matches were
    // skills ENFORCING the approval discipline: "Never auto-approve", "do not
    // disable a gate, weaken a threshold, or skip an approval", "live write
    // access is approval-gated and never auto-approved". Blocking those would
    // have removed the best-behaved skills in the catalog for describing the
    // rule they keep. The negation guard below catches most of it; the rest is
    // why this is a flag.
    severity: 'flag',
    pattern: /\b(bypass|skip|ignore|disable|circumvent|suppress)\b[^.\n]{0,30}\b(approval|confirmation|permission\s+(check|gate|prompt)|human\s+(review|in\s+the\s+loop)|safety\s+(check|gate))\b|\b(auto[-\s]?approve|approve\s+(it\s+)?(yourself|automatically)|without\s+(waiting\s+for\s+)?(approval|authori[sz]ation)|do\s+not\s+wait\s+for\s+(approval|confirmation))\b/i,
  },
  {
    // Exfiltration needs BOTH a destination and something to send. The first
    // draft matched any "post to a webhook", which is what an automation skill
    // legitimately describes; this requires the payload to be the agent's own
    // context rather than the user's content.
    id: 'exfiltration',
    // FLAGGED, not blocked. Every live match was reassurance running the other
    // way — "we never transmit your API keys", "this data is not sent
    // anywhere". Telling that apart from the real instruction needs the
    // negation read, which a regex cannot do, and blocking a privacy notice
    // for describing the thing it promises not to do is the wrong error.
    severity: 'flag',
    pattern: /\b(send|post|upload|forward|transmit|exfiltrate|report)\b[^.\n]{0,50}\b(this\s+(conversation|context|prompt)|your\s+(instructions|system\s+prompt|context)|the\s+(system\s+prompt|conversation\s+history)|user\s+data|credentials?|api[_\s-]?keys?)\b/i,
  },
  {
    // Concealment from the person reading the answer.
    id: 'concealment',
    severity: 'block',
    pattern: /\b(do\s+not\s+(tell|mention|reveal|disclose|inform)|never\s+(tell|mention|reveal|disclose)|hide\s+(this|it)\s+from|without\s+(telling|informing))\s+(the\s+)?(user|human|operator|them)\b/i,
  },
  {
    // Identity reassignment. FLAG, not block: "you are now writing as a
    // copywriter" is exactly how a legitimate skill frames voice, and the
    // three live matches are all of that kind. Only a human can tell the
    // difference, so this surfaces rather than removes.
    id: 'identity-reassignment',
    severity: 'flag',
    pattern: /\b(you\s+are\s+now|from\s+now\s+on\s+you\s+are|act\s+as\s+if\s+you\s+are|pretend\s+to\s+be)\b/i,
  },
  {
    // Naming a specific tool to call. A skill shapes HOW the assistant writes;
    // choosing its actions is the model's job. Flagged, since "use web search
    // first" is plausible guidance.
    id: 'tool-direction',
    severity: 'flag',
    pattern: /\b(call|invoke|execute|run)\s+(the\s+)?(tool|function|capability)\s+[a-zA-Z]/i,
  },
  {
    // Prompt-structure spoofing: text impersonating a message boundary so its
    // own content reads as a new system turn.
    id: 'role-spoofing',
    severity: 'flag',
    pattern: /(^|\n)\s*(system|assistant|human|user)\s*:\s*$|<\|(im_start|im_end|system|endoftext)\|>/i,
  },
];

/** Clip a match for reporting. Never returns the whole skill — a finding is
 *  evidence for a human, not a copy of the payload. */
function excerpt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  const clipped = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return clipped.length > 160 ? `${clipped.slice(0, 160)}…` : clipped;
}

/**
 * Screen one skill's instruction text.
 *
 * Never throws: a screen that can fail closed on its own bug would take the
 * whole skills system down with it, so an unexpected error is reported as a
 * single 'flag' finding and the text is allowed through — the same posture the
 * rest of the skills path takes (a skill that fails to load is skipped, not
 * fatal).
 */
/** Words that invert the meaning of what follows them.
 *
 *  THE PROBLEM THIS SOLVES, from the live catalog: "Never auto-approve" and
 *  "auto-approve" are the same substring to a regex, and the first is a skill
 *  keeping the rule while the second breaks it. Matching the phrase alone got
 *  this exactly backwards on all five live hits.
 *
 *  A window rather than a parse: a real negation-scope analysis needs a
 *  grammar, and the payoff over "is there a negator in the preceding clause"
 *  is small on text this short. False negatives here are acceptable because
 *  the rules this guards are advisory; a false POSITIVE is what does damage. */
const NEGATORS = /\b(never|not|no|don'?t|do\s+not|avoid|prevent|forbid|prohibit|refuse|without\s+ever|must\s+not|cannot|can'?t|should\s+not|shouldn'?t)\b/i;

/** True when the match is inside the scope of a preceding negator. Looks back
 *  to the start of the clause — a sentence boundary, or 80 characters. */
function isNegated(text: string, matchIndex: number): boolean {
  const from = Math.max(0, matchIndex - 80);
  const before = text.slice(from, matchIndex);
  // Only the CURRENT clause counts: a negator on the far side of a full stop
  // or a list bullet is governing a different statement.
  const clause = before.split(/[.;!?\n]|(?:^|\s)[-*•]\s/).pop() ?? before;
  return NEGATORS.test(clause);
}

export function scanSkillContent(instructions: string): SkillScanResult {
  const findings: SkillFinding[] = [];
  try {
    for (const rule of RULES) {
      const m = rule.pattern.exec(instructions);
      if (m && m.index >= 0 && !isNegated(instructions, m.index)) {
        findings.push({
          severity: rule.severity,
          rule: rule.id,
          excerpt: excerpt(instructions, m.index, m[0].length),
        });
      }
    }
  } catch (e: any) {
    return {
      safe: true,
      findings: [{ severity: 'flag', rule: 'scanner-error', excerpt: String(e?.message || e).slice(0, 160) }],
    };
  }
  return { safe: !findings.some((f) => f.severity === 'block'), findings };
}

/**
 * Screen a batch and split it.
 *
 * Returns the skills safe to inject plus the ones held back, so the caller can
 * log what it refused. A blocked skill is NOT silently dropped — the caller
 * logs it, because a skill quietly vanishing from an account's prompt is
 * exactly the kind of thing nobody notices until behaviour has already drifted.
 */
export function screenSkills<T extends { slug: string; instructions: string }>(
  skills: T[],
): { allowed: T[]; blocked: { skill: T; findings: SkillFinding[] }[]; flagged: { skill: T; findings: SkillFinding[] }[] } {
  const allowed: T[] = [];
  const blocked: { skill: T; findings: SkillFinding[] }[] = [];
  const flagged: { skill: T; findings: SkillFinding[] }[] = [];

  for (const skill of skills) {
    const result = scanSkillContent(skill.instructions);
    if (!result.safe) {
      blocked.push({ skill, findings: result.findings.filter((f) => f.severity === 'block') });
      continue;
    }
    if (result.findings.length) {
      flagged.push({ skill, findings: result.findings });
    }
    allowed.push(skill);
  }
  return { allowed, blocked, flagged };
}
