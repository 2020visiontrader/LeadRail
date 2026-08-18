// Open-web search connector. Tavily is primary (built for AI extraction —
// returns clean snippets); SerpAPI (Google results) is the fallback when
// Tavily has no key or errors. Same honest-status pattern as notion.ts /
// gdrive.ts: no key configured is reported, never thrown, so the agent can
// say "I don't have web search configured" instead of silently failing.

const TAVILY_API = 'https://api.tavily.com/search';
const SERPAPI_API = 'https://serpapi.com/search.json';

function resolveTavilyKey(): string | null {
  return process.env.TAVILY_API_KEY || process.env.TAVILY_API_KEY_BACKUP || null;
}

function resolveSerpapiKey(): string | null {
  return process.env.SERPAPI_KEY || null;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  provider: 'tavily' | 'serpapi';
  query: string;
  results: WebSearchHit[];
  answer?: string;
}

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
  return { provider: 'tavily', query, results, answer: json?.answer || undefined };
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
  const results: WebSearchHit[] = organic.slice(0, limit).map((r: any) => ({
    title: String(r?.title || ''),
    url: String(r?.link || ''),
    snippet: String(r?.snippet || ''),
  }));
  const answer = json?.answer_box?.answer || json?.answer_box?.snippet || undefined;
  return { provider: 'serpapi', query, results, answer };
}

/** Search the open web. Tries Tavily first, falls through to SerpAPI on any
 *  error (missing key, rate limit, timeout). Throws only when both fail or
 *  neither is configured — the capability layer turns that into a plain
 *  "web search isn't configured" message rather than a crash. */
export async function webSearch(query: string, limit = 5): Promise<WebSearchResult> {
  try {
    return await tavilySearch(query, limit);
  } catch {
    return await serpapiSearch(query, limit);
  }
}

export interface WebSearchVerifyResult {
  connected: boolean;
  provider?: 'tavily' | 'serpapi';
  error?: string;
}

/** Prove at least one provider is configured, without spending a real query. */
export function verifyWebSearch(): WebSearchVerifyResult {
  if (resolveTavilyKey()) return { connected: true, provider: 'tavily' };
  if (resolveSerpapiKey()) return { connected: true, provider: 'serpapi' };
  return { connected: false, error: 'No TAVILY_API_KEY or SERPAPI_KEY configured.' };
}
