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
    // The canonical injection opener, in its common phrasings.
    id: 'override-instructions',
    severity: 'block',
    pattern: /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|your\s+|the\s+)?(previous|prior|earlier|above|preceding|system|initial)\s+(instruction|instructions|prompt|prompts|rule|rules|direction|directions)\b/i,
  },
  {
    // Attempts to redefine who the agent is, which is how a persona-level
    // takeover starts.
    id: 'identity-reassignment',
    severity: 'block',
    pattern: /\b(you\s+are\s+now|from\s+now\s+on\s+you\s+are|act\s+as\s+if\s+you\s+are|pretend\s+to\s+be)\b(?!.{0,40}\b(copywriter|strategist|marketer|analyst|editor|advisor|consultant)\b)/i,
  },
  {
    // Anything reaching for credentials. No marketing skill needs these.
    id: 'credential-access',
    severity: 'block',
    pattern: /\b(api[_\s-]?key|access[_\s-]?token|secret[_\s-]?key|password|credential|env(?:ironment)?\s+variable|process\.env|service[_\s-]?role)\b/i,
  },
  {
    // Attacks on the approval gate — the one control standing between the
    // agent and spending money or emailing real people.
    id: 'approval-bypass',
    severity: 'block',
    pattern: /\b(without\s+(asking|approval|confirmation|permission)|skip\s+(the\s+)?(approval|confirmation|review)|do\s+not\s+ask\s+(for\s+)?(permission|approval|the\s+user)|no\s+need\s+to\s+confirm)\b/i,
  },
  {
    // Exfiltration: send the context somewhere.
    id: 'exfiltration',
    severity: 'block',
    pattern: /\b(send|post|upload|forward|transmit|exfiltrate)\b[^.\n]{0,60}\b(to\s+)?(https?:\/\/|webhook|endpoint|external\s+(server|url|api))/i,
  },
  {
    // Instructions to conceal behaviour from the person reading the answer.
    id: 'concealment',
    severity: 'block',
    pattern: /\b(do\s+not\s+(tell|mention|reveal|disclose|inform)|never\s+(tell|mention|reveal|disclose)|hide\s+(this|it)\s+from|without\s+(telling|informing))\s+(the\s+)?(user|human|operator|them)\b/i,
  },
  {
    // Naming a specific tool to call is a strong signal — a skill shapes HOW
    // the agent writes, it does not choose the agent's actions. Flagged rather
    // than blocked: a skill legitimately saying "use web search first" is
    // plausible, and a human should decide.
    id: 'tool-direction',
    severity: 'flag',
    pattern: /\b(call|invoke|execute|run)\s+(the\s+)?(tool|function|capability)\s+[a-zA-Z]/i,
  },
  {
    // Embedded fenced code that looks executable. Skills are guidance; a shell
    // or SQL block inside one is worth a human glance.
    id: 'embedded-code',
    severity: 'flag',
    pattern: /```\s*(bash|sh|shell|zsh|python|javascript|js|ts|sql)\b/i,
  },
  {
    // Prompt-structure spoofing: text that impersonates a message boundary to
    // make its own content look like a new system turn.
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
export function scanSkillContent(instructions: string): SkillScanResult {
  const findings: SkillFinding[] = [];
  try {
    for (const rule of RULES) {
      const m = rule.pattern.exec(instructions);
      if (m && m.index >= 0) {
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
