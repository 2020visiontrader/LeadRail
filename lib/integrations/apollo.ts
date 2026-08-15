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
  const ranges: string[] = [];
  for (const part of size.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const key = token.toLowerCase().replace(/[^a-z]/g, '');
    if (map[key]) { ranges.push(map[key]); continue; }
    // Accept an explicit "min-max" passthrough within a single token.
    const m = token.match(/(\d+)\D+(\d+)/);
    if (m) ranges.push(`${m[1]},${m[2]}`);
  }
  return Array.from(new Set(ranges));
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

  // Company-type targeting goes into q_organization_keyword_tags, which Apollo
  // treats as an OR'd, high-recall org-tag match. We fold BOTH the industry and
  // the free-text keyword into it (deduped). Apollo's q_keywords, by contrast,
  // is a strict full-text AND across many fields: combined with title/industry
  // filters it collapses results by 98-99% (verified live — "SaaS founders in
  // Toronto" drops 1,621 → 3 the moment q_keywords is added). So q_keywords is
  // only ever used as a last resort when there is no other targeting signal at
  // all (no keyword-tags AND no titles).
  // Industry and keywords arrive as free-text, frequently comma-separated
  // multi-value ("creator economy, social media, entertainment"). Apollo matches
  // keyword-tags as INDIVIDUAL, OR'd tokens — a single tag literal with embedded
  // commas matches no org, which silently collapses the whole AND'd query to 0
  // results. So split both fields on commas into discrete tags and dedupe.
  const kw = (query.keywords || '').trim();
  const splitTags = (s?: string) => (s || '').split(',').map((t) => t.trim()).filter(Boolean);
  const seen = new Set<string>();
  const orgKeywordTags: string[] = [];
  for (const tag of [...splitTags(query.industry), ...splitTags(query.keywords)]) {
    const dedupeKey = tag.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    orgKeywordTags.push(tag);
  }

  const body: Record<string, any> = {
    page: 1,
    per_page: perPage,
    person_titles: query.titles?.length ? query.titles : undefined,
    person_seniorities: query.seniority?.length ? query.seniority : undefined,
    person_locations: query.location ? query.location.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    organization_num_employees_ranges: sizeToRange(query.company_size),
    q_organization_keyword_tags: orgKeywordTags.length ? orgKeywordTags : undefined,
    q_keywords: !orgKeywordTags.length && !query.titles?.length && kw ? kw : undefined,
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
  id?: string | null;
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
  // Prefer the Apollo person id (captured at import). Matching by the exact id and
  // asking Apollo to reveal is the ONLY reliable way to unlock a masked preview
  // contact — matching by the obfuscated name ("Andrew Ja***n") returns a still-
  // masked record (or the wrong person). Reveal is what consumes the credit.
  const apolloId = keys.id && !/@locked\.apollo$/.test(keys.id) ? keys.id : undefined;
  const body: Record<string, any> = {
    reveal_personal_emails: true,
    id: apolloId,
    email: keys.email && !/@locked\.apollo$/.test(keys.email) ? keys.email : undefined,
    linkedin_url: keys.linkedin_url || undefined,
    name: apolloId ? undefined : keys.name || undefined,
    organization_name: apolloId ? undefined : keys.company || undefined,
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

// ---------------------------------------------------------------------------
// Phase C, item 16 — Organization enrichment + bulk people match.
// Both stay within the free-tier data we already get; org-enrich in particular
// returns firmographics (industry, headcount, funding, tech) with no per-email
// unlock cost, so it's the cheapest data lift on the import path.
// ---------------------------------------------------------------------------

export interface ApolloOrg {
  name: string | null;
  domain: string | null;
  website_url: string | null;
  industry: string | null;
  estimated_num_employees: number | null;
  annual_revenue: number | null;
  founded_year: number | null;
  linkedin_url: string | null;
  location: string | null;
  technologies: string[];
  raw: Record<string, any>;
}

/** Enrich a company by domain (preferred) or name via Apollo Organization Enrichment. */
export async function enrichOrganization(keys: { domain?: string | null; name?: string | null }): Promise<ApolloOrg | null> {
  const key = apolloKey();
  if (!key) {
    const err: any = new Error('Apollo is not connected');
    err.code = 'not_configured';
    throw err;
  }
  const domain = (keys.domain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
  if (!domain && !keys.name) return null;

  const params = new URLSearchParams();
  if (domain) params.set('domain', domain);
  else if (keys.name) params.set('name', keys.name);

  const res = await fetch(`${APOLLO_BASE}/organizations/enrich?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Api-Key': key },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err: any = new Error(`Apollo org enrich failed (${res.status})`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.detail = text.slice(0, 300);
    throw err;
  }
  const json = await res.json();
  const o = json.organization || json.account || null;
  if (!o) return null;
  return {
    name: o.name || null,
    domain: o.primary_domain || o.domain || domain || null,
    website_url: o.website_url || null,
    industry: o.industry || null,
    estimated_num_employees: o.estimated_num_employees ?? null,
    annual_revenue: o.annual_revenue ?? o.organization_revenue ?? null,
    founded_year: o.founded_year ?? null,
    linkedin_url: o.linkedin_url || null,
    location: [o.city, o.state, o.country].filter(Boolean).join(', ') || null,
    technologies: Array.isArray(o.technology_names) ? o.technology_names : [],
    raw: o,
  };
}

/** Enrich up to 10 people in one call via Apollo People Bulk Match. */
export async function matchPeopleBulk(
  details: Array<{ email?: string | null; linkedin_url?: string | null; name?: string | null; company?: string | null }>
): Promise<ApolloEnrichment[]> {
  const key = apolloKey();
  if (!key) {
    const err: any = new Error('Apollo is not connected');
    err.code = 'not_configured';
    throw err;
  }
  const details_body = details.slice(0, 10).map((k) => {
    const d: Record<string, any> = {};
    if (k.email && !/@locked\.apollo$/.test(k.email)) d.email = k.email;
    if (k.linkedin_url) d.linkedin_url = k.linkedin_url;
    if (k.name) d.name = k.name;
    if (k.company) d.organization_name = k.company;
    return d;
  });
  const res = await fetch(`${APOLLO_BASE}/people/bulk_match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Api-Key': key },
    body: JSON.stringify({ reveal_personal_emails: false, details: details_body }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err: any = new Error(`Apollo bulk match failed (${res.status})`);
    err.code = res.status === 401 || res.status === 403 ? 'auth' : 'upstream';
    err.detail = text.slice(0, 300);
    throw err;
  }
  const json = await res.json();
  const matches: any[] = json.matches || json.people || [];
  return matches.map((p: any): ApolloEnrichment => {
    const org = p?.organization || {};
    const rawEmail: string | undefined = p?.email;
    const locked = !rawEmail || /not_unlocked/i.test(rawEmail);
    return {
      title: p?.title || null,
      seniority: p?.seniority || null,
      headline: p?.headline || null,
      location: [p?.city, p?.state, p?.country].filter(Boolean).join(', ') || null,
      linkedin_url: p?.linkedin_url || null,
      employment_history: (p?.employment_history || []).map((e: any) => ({ title: e.title, organization_name: e.organization_name })),
      organization: org.name ? { name: org.name, industry: org.industry, estimated_num_employees: org.estimated_num_employees, website_url: org.website_url } : null,
      email: locked ? null : rawEmail!,
      email_status: locked ? 'locked' : 'verified',
      raw: p || {},
    };
  });
}
