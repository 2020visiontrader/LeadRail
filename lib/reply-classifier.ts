// Structured reply-outcome classifier (Phase C, item 8).
// Rule-based on purpose: runs with zero LLM cost/latency inside the send loop.
// eracle uses an LLM here; the enum + call site are designed so an AI pass can
// replace `classifyReply` later without touching the engine.

export type ReplyOutcome =
  | 'converted'
  | 'not_interested'
  | 'no_budget'
  | 'has_solution'
  | 'bad_timing'
  | 'unknown';

// Ordered by priority: the first bucket whose pattern hits wins. Positive
// intent is checked first so "yes, but no budget right now" reads as converted
// only on a real booking signal, not a soft maybe.
const RULES: Array<{ outcome: ReplyOutcome; re: RegExp }> = [
  {
    outcome: 'converted',
    re: /\b(let'?s (talk|chat|do it)|book(ed|ing)?|schedule|calendar|demo|sign me up|interested in (a|the) (call|demo)|sounds (great|good)|happy to (chat|meet)|works for me|send (me )?(the )?(contract|proposal|invoice))\b/i,
  },
  {
    outcome: 'no_budget',
    re: /\b(no budget|budget (is )?(tight|frozen|cut)|can'?t afford|too expensive|out of (our )?budget|not in the budget|financially)\b/i,
  },
  {
    outcome: 'has_solution',
    re: /\b(already (have|use|using|got)|we use|currently (use|with)|existing (vendor|provider|solution)|happy with (our|my)|under contract with)\b/i,
  },
  {
    outcome: 'bad_timing',
    re: /\b(not (right )?now|later|next (quarter|year|month)|circle back|reach out (again )?in|bad timing|too busy|revisit|q[1-4] ?20|follow up in)\b/i,
  },
  {
    outcome: 'not_interested',
    re: /\b(not interested|no thank|no thanks|unsubscribe|remove me|stop (emailing|contacting)|please stop|do not (contact|email)|not a (fit|priority)|pass\b)\b/i,
  },
];

/** Classify an inbound reply body into a structured outcome. */
export function classifyReply(body: string | null | undefined): ReplyOutcome {
  const text = (body || '').slice(0, 4000);
  if (!text.trim()) return 'unknown';
  for (const { outcome, re } of RULES) {
    if (re.test(text)) return outcome;
  }
  return 'unknown';
}
