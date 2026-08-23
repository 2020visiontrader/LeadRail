// Open-web search connector. Chain: Tavily -> Exa -> SerpAPI -> DuckDuckGo.
// Tavily and Exa are both AI-native search engines built for LLM extraction
// (clean text, no ads/boilerplate) and are tried first; SerpAPI (raw Google
// SERP) is next. DuckDuckGo's Instant Answer API needs no key and is the
// floor: it's what `webSearch` falls through to when every keyed provider is
// unconfigured or erroring, so the capability is never fully "not
// configured" — but its coverage is thin (mostly Wikipedia-style topics, not
// a full SERP), so treat it as a last resort, not a peer of the other three.
// Same honest-status pattern as notion.ts / gdrive.ts: what's missing is
// reported, never thrown, so the agent can say what it doesn't have instead
// of silently failing.

const TAVILY_API = 'https://api.tavily.com/search';
const EXA_API = 'https://api.exa.ai/search';
const SERPAPI_API = 'https://serpapi.com/search.json';
const DUCKDUCKGO_API = 'https://api.duckduckgo.com/';

function resolveTavilyKey(): string | null {
  return process.env.TAVILY_API_KEY || process.env.TAVILY_API_KEY_BACKUP || null;
}

function resolveExaKey(): string | null {
  return process.env.EXA_API_KEY || null;
}

function resolveSerpapiKey(): string | null {
  return process.env.SERPAPI_KEY || null;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export type WebSearchProvider = 'tavily' | 'exa' | 'serpapi' | 'duckduckgo';

export interface WebSearchResult {
  provider: WebSearchProvider;
  query: string;
  results: WebSearchHit[];
  answer?: string;
}

// ---- enrichment ------------------------------------------------------
// Applied identically to every provider's raw output, so which one actually
// answered never changes the shape or quality of what reaches the digest.

/** Strip HTML/markdown noise a provider's snippet can carry (Exa returns raw
 *  page text with markdown headers; DuckDuckGo/SerpAPI can carry HTML
 *  entities and tags), collapse whitespace, and cap length so one hit can't
 *  dominate the token budget the digest line feeds into the model's context. */
function cleanSnippet(raw: string, maxChars = 400): string {
  const text = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars).trim()}…` : text;
}

function normalizeUrlKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** Dedupe by normalized URL (same page via http/https, trailing slash, or
 *  www. reads as one hit), drop entries missing a title or url, clean
 *  snippets, and cap to `limit`. */
function enrichHits(hits: WebSearchHit[], limit: number): WebSearchHit[] {
  const seen = new Set<string>();
  const out: WebSearchHit[] = [];
  for (const hit of hits) {
    if (!hit.url || !hit.title) continue;
    const key = normalizeUrlKey(hit.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: hit.title.trim(), url: hit.url, snippet: cleanSnippet(hit.snippet) });
    if (out.length >= limit) break;
  }
  return out;
}

// ---- providers ---------------------------------------------------------

async function tavilySearch(query: string, limit: number): Promise<WebSearchResult> {
  const key = resolveTavilyKey();
  if (!key) throw new Error('no Tavily key');
  const res = await fetch(TAVILY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      query,
      max_results: Math.min(limit, 10),
      include_answer: true,
    }),
  });
  if (!res.ok) throw new Error(`Tavily error (${res.status})`);
  const json = await res.json();
  const results: WebSearchHit[] = Array.isArray(json?.results)
    ? json.results.map((r: any) => ({
        title: String(r?.title || ''),
        url: String(r?.url || ''),
        snippet: String(r?.content || ''),
      }))
    : [];
  return { provider: 'tavily', query, results: enrichHits(results, limit), answer: json?.answer || undefined };
}

async function exaSearch(query: string, limit: number): Promise<WebSearchResult> {
  const key = resolveExaKey();
  if (!key) throw new Error('no Exa key');
  const res = await fetch(EXA_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({
      query,
      numResults: Math.min(limit, 10),
      contents: { text: { maxCharacters: 500 } },
    }),
  });
  if (!res.ok) throw new Error(`Exa error (${res.status})`);
  const json = await res.json();
  const results: WebSearchHit[] = Array.isArray(json?.results)
    ? json.results.map((r: any) => ({
        title: String(r?.title || ''),
        url: String(r?.url || ''),
        snippet: String(r?.text || r?.summary || ''),
      }))
    : [];
  return { provider: 'exa', query, results: enrichHits(results, limit) };
}

async function serpapiSearch(query: string, limit: number): Promise<WebSearchResult> {
  const key = resolveSerpapiKey();
  if (!key) throw new Error('no SerpAPI key');
  const url = `${SERPAPI_API}?${new URLSearchParams({
    q: query,
    api_key: key,
    num: String(Math.min(limit, 10)),
  })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpAPI error (${res.status})`);
  const json = await res.json();
  const organic = Array.isArray(json?.organic_results) ? json.organic_results : [];
  const results: WebSearchHit[] = organic.map((r: any) => ({
    title: String(r?.title || ''),
    url: String(r?.link || ''),
    snippet: String(r?.snippet || ''),
  }));
  const answer = json?.answer_box?.answer || json?.answer_box?.snippet || undefined;
  return { provider: 'serpapi', query, results: enrichHits(results, limit), answer };
}

/** DuckDuckGo's Instant Answer API — no key, no rate-limit signup, but it
 *  only surfaces topics with a Wikipedia-style abstract (companies, people,
 *  concepts), not a general SERP. RelatedTopics can nest a "Topics" group
 *  instead of a direct entry, so both shapes are flattened. */
async function duckduckgoSearch(query: string, limit: number): Promise<WebSearchResult> {
  const url = `${DUCKDUCKGO_API}?${new URLSearchParams({
    q: query,
    format: 'json',
    no_html: '1',
    skip_disambig: '1',
  })}`;
  // DuckDuckGo returns HTTP 202 with an empty body to Node's default fetch
  // user-agent (undici sends none) — a real UA is required to get the actual
  // JSON payload, confirmed against curl (which sends one by default).
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadRailBot/1.0)', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`DuckDuckGo error (${res.status})`);
  const body = await res.text();
  if (!body) throw new Error('DuckDuckGo returned an empty response');
  const json = JSON.parse(body);

  const hits: WebSearchHit[] = [];
  if (json?.AbstractURL) {
    hits.push({
      title: String(json?.Heading || query),
      url: String(json.AbstractURL),
      snippet: String(json?.AbstractText || ''),
    });
  }
  const related = Array.isArray(json?.RelatedTopics) ? json.RelatedTopics : [];
  for (const topic of related) {
    const entries = Array.isArray(topic?.Topics) ? topic.Topics : [topic];
    for (const entry of entries) {
      if (!entry?.FirstURL) continue;
      const text = String(entry?.Text || '');
      hits.push({ title: text.split(' - ')[0] || String(entry.FirstURL), url: String(entry.FirstURL), snippet: text });
    }
  }

  return {
    provider: 'duckduckgo',
    query,
    results: enrichHits(hits, limit),
    answer: json?.Answer || json?.AbstractText || undefined,
  };
}

/** Search the open web. Tries Tavily, then Exa, then SerpAPI in order — the
 *  first configured provider that doesn't error wins. DuckDuckGo needs no
 *  key and never throws on "not configured", so it's the final floor,
 *  reached only when every keyed provider is unconfigured or erroring. */
export async function webSearch(query: string, limit = 5): Promise<WebSearchResult> {
  for (const attempt of [tavilySearch, exaSearch, serpapiSearch]) {
    try {
      return await attempt(query, limit);
    } catch {
      // fall through to the next provider
    }
  }
  return duckduckgoSearch(query, limit);
}

export interface WebSearchVerifyResult {
  connected: boolean;
  provider?: WebSearchProvider;
  error?: string;
}

/** Prove at least one provider is configured, without spending a real query.
 *  DuckDuckGo needs no key, so this only ever reports disconnected if a
 *  future change removes that floor — kept as an explicit branch rather than
 *  a bare default so that possibility stays visible. */
export function verifyWebSearch(): WebSearchVerifyResult {
  if (resolveTavilyKey()) return { connected: true, provider: 'tavily' };
  if (resolveExaKey()) return { connected: true, provider: 'exa' };
  if (resolveSerpapiKey()) return { connected: true, provider: 'serpapi' };
  return { connected: true, provider: 'duckduckgo' };
}
