import type { ApolloQuery } from '@/lib/types';

const APOLLO_BASE = 'https://api.apollo.io/api/v1';

/** Resolve the Apollo key across accepted secret-name casings. */
export function apolloKey(): string | undefined {
  return process.env.APOLLO_API_KEY || process.env.Apollo_Api_Key || process.env.APOLLO_KEY;
}

export function apolloConfigured(): boolean {
  return Boolean(apolloKey());
}

export interface ApolloCandidate {
  external_id: string;
  name: string;
  email: string | null;
  email_status: 'verified' | 'locked' | 'unavailable';
  title: string;
  company: string;
  linkedin_url: string | null;
  location: string | null;
  seniority: string | null;
  raw: Record<string, any>;
}

/** Split a free-form company-size label into an Apollo employee-range token. */
function sizeToRange(size?: string): string[] {
  if (!size) return [];
  const map: Record<string, string> = {
    startup: '1,10',
    small: '11,50',
    smb: '51,200',
    mid: '201,1000',
    midmarket: '201,1000',
    enterprise: '1001,10000',
    large: '1001,10000',
  };
  const key = size.toLowerCase().replace(/[^a-z]/g, '');
  if (map[key]) return [map[key]];
  // Accept an explicit "min,max" or "min-max" passthrough.
  const m = size.match(/(\d+)\D+(\d+)/);
  return m ? [`${m[1]},${m[2]}`] : [];
}

/**
 * Normalize a person from Apollo's `api_search` preview shape. That endpoint
 * returns obfuscated data — `last_name_obfuscated`, boolean `has_email`/
 * `has_city`/`has_state`/`has_country` flags (not values), no seniority. Full
 * name, email, and location are revealed only by the enrich (People Match)
 * call, which unlocks the record and spends Apollo credits. This also handles
 * a fuller shape (paid search tiers / match results) when those fields exist.
 */
function normalize(p: any): ApolloCandidate {
  const rawEmail: string | undefined = p.email;
  const hasEmail = p.has_email === true;
  // Preview tier: no real email string, only a has_email flag → treat as locked-but-revealable.
  const emailPresent = typeof rawEmail === 'string' && !/email_not_unlocked|not_unlocked/i.test(rawEmail);
  const email_status: ApolloCandidate['email_status'] = emailPresent
    ? 'verified'
    : hasEmail
      ? 'locked'
      : 'unavailable';
  const org = p.organization || p.account || {};
  const lastName = p.last_name || p.last_name_obfuscated || '';
  const location = [p.city, p.state, p.country].filter(Boolean).join(', ') || null;
  return {
    external_id: p.id || p.person_id || '',
    name: [p.first_name, lastName].filter(Boolean).join(' ') || p.name || 'Unknown',
    email: emailPresent ? rawEmail! : null,
    email_status,
    title: p.title || '',
    company: org.name || p.organization_name || '',
    linkedin_url: p.linkedin_url || null,
    location,
    seniority: p.seniority || null,
    raw: p,
  };
}

/**
 * People Search against Apollo. Describe an ICP (industry, titles, seniority,
 * location, size, keywords) → normalized candidates. Throws a typed error the
 * route maps to a clean 4xx/5xx; never returns fabricated data.
 */
export async function searchPeople(
  query: ApolloQuery
): Promise<{ candidates: ApolloCandidate[]; total: number }> {
  const key = apolloKey();
  if (!key) {
    const err: any = new Error('Apollo is not connected');
    err.code = 'not_configured';
    throw err;
  }

  const perPage = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const body: Record<string, any> = {
    page: 1,
    per_page: perPage,
    person_titles: query.titles?.length ? query.titles : undefined,
    person_seniorities: query.seniority?.length ? query.seniority : undefined,
    person_locations: query.location ? [query.location] : undefined,
    organization_num_employees_ranges: sizeToRange(query.company_size),
    q_keywords: [query.industry, query.keywords].filter(Boolean).join(' ') || undefined,
  };
  Object.keys(body).forEach((k) => {
    const v = body[k];
    if (v === undefined || (Array.isArray(v) && v.length === 0)) delete body[k];
  });

  const res = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Api-Key': key,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err: any = new Error(`Apollo search failed (${res.status})`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.detail = text.slice(0, 300);
    throw err;
  }

  const json = await res.json();
  const people: any[] = json.people || json.contacts || [];
  const total = json.total_entries ?? json.pagination?.total_entries ?? people.length;
  return { candidates: people.map(normalize), total };
}

/** Map an Apollo candidate to a contacts-table insert row. */
export function candidateToContact(
  c: ApolloCandidate,
  accountId: string,
  brandId: string
): Record<string, any> {
  return {
    account_id: accountId,
    brand_id: brandId,
    name: c.name,
    email: c.email || `${c.external_id || c.name.replace(/\s+/g, '.').toLowerCase()}@locked.apollo`,
    company: c.company || null,
    title: c.title || null,
    segment: 'other',
    status: 'new',
    source: 'apollo',
    linkedin_url: c.linkedin_url,
    enrichment_status: 'none',
    enriched: { apollo_id: c.external_id, seniority: c.seniority, location: c.location, email_status: c.email_status },
  };
}

export interface ApolloEnrichment {
  title: string | null;
  seniority: string | null;
  headline: string | null;
  location: string | null;
  linkedin_url: string | null;
  employment_history: Array<{ title?: string; organization_name?: string }>;
  organization: { name?: string; industry?: string; estimated_num_employees?: number; website_url?: string } | null;
  email: string | null;
  email_status: 'verified' | 'locked' | 'unavailable';
  raw: Record<string, any>;
}

/**
 * Enrich a single person via Apollo People Match. Match keys (any subset):
 * email, linkedin_url, name + company. Returns a deep profile or throws typed.
 */
export async function matchPerson(keys: {
  email?: string | null;
  linkedin_url?: string | null;
  name?: string | null;
  company?: string | null;
}): Promise<ApolloEnrichment> {
  const key = apolloKey();
  if (!key) {
    const err: any = new Error('Apollo is not connected');
    err.code = 'not_configured';
    throw err;
  }
  const body: Record<string, any> = {
    reveal_personal_emails: false,
    email: keys.email && !/@locked\.apollo$/.test(keys.email) ? keys.email : undefined,
    linkedin_url: keys.linkedin_url || undefined,
    name: keys.name || undefined,
    organization_name: keys.company || undefined,
  };
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

  const res = await fetch(`${APOLLO_BASE}/people/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Api-Key': key },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err: any = new Error(`Apollo enrich failed (${res.status})`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.detail = text.slice(0, 300);
    throw err;
  }
  const json = await res.json();
  const p = json.person || json.people?.[0] || {};
  const org = p.organization || {};
  const rawEmail: string | undefined = p.email;
  const locked = !rawEmail || /not_unlocked/i.test(rawEmail);
  return {
    title: p.title || null,
    seniority: p.seniority || null,
    headline: p.headline || null,
    location: [p.city, p.state, p.country].filter(Boolean).join(', ') || null,
    linkedin_url: p.linkedin_url || null,
    employment_history: (p.employment_history || []).map((e: any) => ({
      title: e.title,
      organization_name: e.organization_name,
    })),
    organization: org.name
      ? {
          name: org.name,
          industry: org.industry,
          estimated_num_employees: org.estimated_num_employees,
          website_url: org.website_url,
        }
      : null,
    email: locked ? null : rawEmail!,
    email_status: locked ? 'locked' : 'verified',
    raw: p,
  };
}
