// Shared lead taxonomy — the vocabulary the whole app agrees on so the
// onboarding wizard, the venture profile, and the Apollo lead search all speak
// the same language. A venture picks ONE primary lead goal and one or more
// target sectors; together they seed who gets pulled and how the ICP is framed.

export interface LeadGoal {
  key: string;
  label: string;
  hint: string; // shown under the option in the wizard
  // Apollo seniority tokens + title cues this goal biases the search toward.
  seniority: string[];
  titleCues: string[];
}

// Ordered by how commonly ventures/individuals search for each. This is the
// dropdown the user asked for: "who are you trying to reach with this venture."
export const LEAD_GOALS: LeadGoal[] = [
  {
    key: 'investors',
    label: 'Investors',
    hint: 'VCs, angels, family offices, syndicates — for a raise',
    seniority: ['partner', 'founder', 'owner', 'c_suite'],
    titleCues: ['partner', 'general partner', 'principal', 'angel investor', 'managing director', 'venture'],
  },
  {
    key: 'customers',
    label: 'Customers / Users',
    hint: 'Buyers or end users of the product (your ICP)',
    seniority: ['head', 'director', 'vp', 'manager', 'c_suite'],
    titleCues: [],
  },
  {
    key: 'marketing_agencies',
    label: 'Marketing agencies',
    hint: 'Agencies to hire, resell through, or co-market with',
    seniority: ['owner', 'founder', 'c_suite', 'vp', 'head'],
    titleCues: ['agency', 'growth', 'marketing', 'demand generation', 'performance marketing'],
  },
  {
    key: 'partners',
    label: 'Partners / Resellers',
    hint: 'Channel, integration, distribution or referral partners',
    seniority: ['owner', 'founder', 'c_suite', 'vp', 'head', 'director'],
    titleCues: ['partnerships', 'business development', 'alliances', 'channel', 'bd'],
  },
  {
    key: 'enterprise',
    label: 'Enterprise buyers',
    hint: 'Decision-makers inside large brands / companies',
    seniority: ['c_suite', 'vp', 'head', 'director'],
    titleCues: ['chief', 'vp', 'head of', 'director of', 'procurement'],
  },
  {
    key: 'talent',
    label: 'Talent / Vendors',
    hint: 'Contractors, freelancers, service providers to hire',
    seniority: ['senior', 'manager', 'owner', 'founder'],
    titleCues: ['freelance', 'consultant', 'specialist', 'contractor'],
  },
  {
    key: 'media',
    label: 'Media / Press',
    hint: 'Journalists, creators, podcasters, newsletter operators',
    seniority: ['senior', 'head', 'director', 'owner'],
    titleCues: ['editor', 'journalist', 'writer', 'producer', 'host', 'creator'],
  },
];

export function getLeadGoal(key?: string | null): LeadGoal | undefined {
  return LEAD_GOALS.find((g) => g.key === key);
}

// Sectors the venture is targeting. Multi-select dropdown in the wizard; each
// selected sector is added to the Apollo industry/keyword search so results
// stay on-topic for that venture.
export interface Sector {
  key: string;
  label: string;
  // Apollo-friendly industry keywords this sector expands to.
  keywords: string[];
}

export const SECTORS: Sector[] = [
  { key: 'saas', label: 'SaaS / Software', keywords: ['saas', 'software', 'b2b software', 'cloud'] },
  { key: 'fintech', label: 'Fintech', keywords: ['fintech', 'financial services', 'payments', 'banking'] },
  { key: 'ecommerce', label: 'E-commerce / Retail', keywords: ['ecommerce', 'e-commerce', 'retail', 'dtc', 'consumer goods'] },
  { key: 'healthtech', label: 'Health / Biotech', keywords: ['healthtech', 'health care', 'biotech', 'medical', 'wellness'] },
  { key: 'media', label: 'Media / Entertainment', keywords: ['media', 'entertainment', 'film', 'streaming', 'publishing'] },
  { key: 'creator', label: 'Creator economy', keywords: ['creator economy', 'influencer', 'content creator', 'social media'] },
  { key: 'ai', label: 'AI / ML', keywords: ['artificial intelligence', 'machine learning', 'ai', 'ml', 'data science'] },
  { key: 'realestate', label: 'Real estate / Proptech', keywords: ['real estate', 'proptech', 'property', 'construction'] },
  { key: 'education', label: 'Education / Edtech', keywords: ['edtech', 'education', 'e-learning', 'training'] },
  { key: 'marketing', label: 'Marketing / Advertising', keywords: ['marketing', 'advertising', 'adtech', 'agency', 'martech'] },
  { key: 'gaming', label: 'Gaming', keywords: ['gaming', 'games', 'esports', 'game development'] },
  { key: 'travel', label: 'Travel / Hospitality', keywords: ['travel', 'hospitality', 'tourism', 'hotels'] },
  { key: 'logistics', label: 'Logistics / Supply chain', keywords: ['logistics', 'supply chain', 'transportation', 'freight'] },
  { key: 'sustainability', label: 'Climate / Sustainability', keywords: ['climate', 'sustainability', 'cleantech', 'renewable energy'] },
  { key: 'manufacturing', label: 'Manufacturing / Industrial', keywords: ['manufacturing', 'industrial', 'hardware', 'iot'] },
  { key: 'professional', label: 'Professional services', keywords: ['consulting', 'legal', 'accounting', 'professional services'] },
  { key: 'nonprofit', label: 'Nonprofit / Social impact', keywords: ['nonprofit', 'ngo', 'social impact', 'foundation'] },
  { key: 'other', label: 'Other', keywords: [] },
];

export function getSector(key: string): Sector | undefined {
  return SECTORS.find((s) => s.key === key);
}

export function sectorKeywords(keys: string[] | undefined | null): string[] {
  if (!Array.isArray(keys)) return [];
  const out = new Set<string>();
  for (const k of keys) getSector(k)?.keywords.forEach((w) => out.add(w));
  return Array.from(out);
}

// A venture's stored ICP profile — what the deck + goal + sectors distilled to.
// Seeds the Apollo search form so the user rarely hand-tunes filters.
export interface VentureIcp {
  industry?: string;
  titles?: string[];
  seniority?: string[];
  keywords?: string;
  company_size?: string;
  segments?: string[]; // suggested lead segments this venture cares about
}
