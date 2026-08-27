// Entity resolution: which record is this turn actually about?
//
// THIS DID NOT EXIST. The architecture note that prompted this work assumed
// `lib/agent/context.ts` already resolved entities and said to reuse it. It does
// not — a grep for any message-to-contact/deal resolution across lib/ and app/
// returns nothing. context.ts resolves the VENTURE ("WHICH VENTURE — no venture
// is selected...") and otherwise assembles account-level counts. Every
// subject-scoped retrieval step depends on this, so it is a prerequisite, not a
// reuse.
//
// DETERMINISTIC ON PURPOSE. No model call. Resolution runs on the live path
// before the prompt is built, so it has to be fast and predictable, and a
// mis-resolution silently attaches memory to the wrong record — which is worse
// than not resolving at all. Exact-ish matching on names, emails and domains
// gets the common cases ("what did Jane say about the renewal") and abstains on
// everything else. An LLM pass belongs in the async extractor, where being
// wrong is cheap and reviewable, not here.

import { supabase } from '@/lib/db';
import type { SubjectRef } from './types';

/** Upper bound on candidates pulled per type. Resolution is a hot-path query;
 *  an account with thousands of contacts must not turn one turn into a scan. */
const CANDIDATE_LIMIT = 500;
/** Most subjects one turn may resolve to. A message naming six people is
 *  usually a list operation, not six subjects worth loading memory for. */
const MAX_SUBJECTS = 4;

/** Tokens too common or too short to identify anybody. A bare "Al" or "Sales"
 *  matching a contact would attach memory to the wrong person. */
const MIN_NAME_TOKEN = 3;
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'about', 'what', 'who',
  'our', 'their', 'them', 'they', 'have', 'has', 'was', 'were', 'get', 'got',
  'lead', 'leads', 'deal', 'deals', 'contact', 'contacts', 'company', 'email',
  'campaign', 'campaigns', 'brand', 'segment', 'note', 'notes', 'send', 'call',
]);

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9@.\s-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Does `needle` (a record's name) appear in the message as a whole phrase?
 *
 *  `raw` is the ORIGINAL message, not the normalised one, because a
 *  single-token name needs a proper-noun check and case is the only signal
 *  available for it.
 *
 *  A multi-word name ("Jane Doe") is distinctive enough to match
 *  case-insensitively. A single-word name is not: a contact called "Sales" or a
 *  company called "Apple" would otherwise absorb every message that happens to
 *  use the word. Requiring the single-token case to appear capitalised as the
 *  record spells it is what separates "How are sales looking?" from "Sales said
 *  they'd follow up." A stopword list alone cannot do this — it is endless, and
 *  the next account's contact is named something not on it. */
function mentions(hayNorm: string, raw: string, needle: string): boolean {
  const n = norm(needle);
  if (!n || n.length < MIN_NAME_TOKEN) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokens = n.split(' ');

  if (tokens.length === 1) {
    if (STOPWORDS.has(n)) return false;
    // Proper-noun check against the raw text, preserving the record's own
    // capitalisation. Abstaining on a lowercase mention is the safe direction:
    // a missed subject falls back to today's account-scoped grounding, while a
    // false one feeds another record's memory to the model as established fact.
    const escRaw = needle.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\W)${escRaw}(\\W|$)`).test(raw);
  }

  return new RegExp(`(^|\\W)${esc}(\\W|$)`, 'i').test(hayNorm);
}

interface Row { id: string; name: string | null; email?: string | null; domain?: string | null }

async function fetchRows(table: string, accountId: string, cols: string): Promise<Row[]> {
  try {
    const { data, error } = await supabase
      .from(table).select(cols).eq('account_id', accountId).limit(CANDIDATE_LIMIT);
    if (error || !Array.isArray(data)) return [];
    return data as unknown as Row[];
  } catch {
    return [];
  }
}

/**
 * Resolve the subjects a message concerns.
 *
 * Never throws and never guesses: an unresolvable message returns [], and the
 * caller falls back to account-scoped grounding exactly as it does today. A
 * brand is included when the caller already knows which venture is selected,
 * because brand memory (voice rules, what the brand will not say) should
 * condition every turn in that venture, not only turns that name it.
 */
export async function resolveSubjects(opts: {
  accountId: string;
  message?: string;
  /** The venture selected in the UI, if any — always a subject when present. */
  brandId?: string;
  brandName?: string;
}): Promise<SubjectRef[]> {
  const found: SubjectRef[] = [];
  const seen = new Set<string>();
  const add = (s: SubjectRef) => {
    const k = `${s.type}:${s.id}`;
    if (seen.has(k) || found.length >= MAX_SUBJECTS) return;
    seen.add(k);
    found.push(s);
  };

  // The selected venture is a subject regardless of whether it was named.
  if (opts.brandId) add({ type: 'brand', id: opts.brandId, label: opts.brandName });

  const raw = (opts.message || '').trim();
  if (!raw) return found;
  const hay = norm(raw);

  // Emails first — the highest-precision signal available, and the one that
  // survives a name being spelled differently than the CRM has it.
  const emails = new Set((raw.match(EMAIL_RE) || []).map((e) => e.toLowerCase()));

  const [contacts, companies, deals, campaigns, segments] = await Promise.all([
    fetchRows('contacts', opts.accountId, 'id, name, email'),
    fetchRows('companies', opts.accountId, 'id, name, domain'),
    fetchRows('deals', opts.accountId, 'id, name'),
    fetchRows('ad_campaigns', opts.accountId, 'id, name'),
    fetchRows('segments', opts.accountId, 'id, name'),
  ]);

  for (const c of contacts) {
    if (c.email && emails.has(c.email.toLowerCase())) add({ type: 'contact', id: c.id, label: c.name || c.email });
  }
  for (const c of contacts) {
    if (c.name && mentions(hay, raw, c.name)) add({ type: 'contact', id: c.id, label: c.name });
  }
  for (const c of companies) {
    const byDomain = c.domain && hay.includes(norm(c.domain));
    if (byDomain || (c.name && mentions(hay, raw, c.name))) add({ type: 'company', id: c.id, label: c.name || c.domain || undefined });
  }
  for (const d of deals) if (d.name && mentions(hay, raw, d.name)) add({ type: 'deal', id: d.id, label: d.name });
  for (const c of campaigns) if (c.name && mentions(hay, raw, c.name)) add({ type: 'campaign', id: c.id, label: c.name });
  for (const s of segments) if (s.name && mentions(hay, raw, s.name)) add({ type: 'segment', id: s.id, label: s.name });

  return found;
}
