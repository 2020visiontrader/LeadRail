import type { ApolloQuery } from '@/lib/types';

const APOLLO_BASE = 'https://api.apollo.io/api/v1';

export function apolloConfigured(): boolean {
  return Boolean(process.env.APOLLO_API_KEY);
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

function normalize(p: any): ApolloCandidate {
  const rawEmail: string | undefined = p.email;
  const locked = !rawEmail || /email_not_unlocked|not_unlocked/i.test(rawEmail);
  const org = p.organization || p.account || {};
  const location = [p.city, p.state, p.country].filter(Boolean).join(', ') || null;
  return {
    external_id: p.id || p.person_id || '',
    name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name || 'Unknown',
    email: locked ? null : rawEmail!,
    email_status: locked ? 'locked' : 'verified',
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
  const key = process.env.APOLLO_API_KEY;
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

  const res = await fetch(`${APOLLO_BASE}/mixed_people/search`, {
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
  const total = json.pagination?.total_entries ?? people.length;
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
