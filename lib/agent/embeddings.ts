// LeadRail AI — text embeddings via NVIDIA NIM (nv-embedqa-e5-v5, 1024-dim).
//
// Used by the durable-memory layer (lib/agent/memory.ts) for semantic recall.
// Everything here is best-effort: if the provider is unreachable or the key is
// missing, we return null and the caller degrades to recency-only recall. An
// embedding failure must NEVER break a chat turn or a memory write.

const NIM_URL = 'https://integrate.api.nvidia.com/v1/embeddings';
const MODEL = 'nvidia/nv-embedqa-e5-v5';
export const EMBEDDING_DIM = 1024;

const TIMEOUT_MS = 8_000;

/** nv-embedqa distinguishes stored passages from search queries. */
type InputType = 'passage' | 'query';

async function embed(texts: string[], inputType: InputType): Promise<number[][] | null> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key || !texts.length) return null;
  const clean = texts.map((t) => (t || '').slice(0, 2048)).filter(Boolean);
  if (!clean.length) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(NIM_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: clean, model: MODEL, input_type: inputType, truncate: 'END' }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const vectors = (data?.data || [])
      .sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
      .map((d: any) => d?.embedding)
      .filter((v: any) => Array.isArray(v) && v.length === EMBEDDING_DIM);
    return vectors.length ? vectors : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Embed a single passage for storage. Returns null on any failure. */
export async function embedPassage(text: string): Promise<number[] | null> {
  const out = await embed([text], 'passage');
  return out?.[0] ?? null;
}

/** Embed a single search query for retrieval. Returns null on any failure. */
export async function embedQuery(text: string): Promise<number[] | null> {
  const out = await embed([text], 'query');
  return out?.[0] ?? null;
}

/** Batch-embed passages (for backfill). Returns null on any failure. */
export async function embedPassages(texts: string[]): Promise<number[][] | null> {
  return embed(texts, 'passage');
}

/** Serialize a vector for pgvector text input, e.g. "[0.1,0.2,...]". */
export function toPgVector(v: number[]): string {
  return `[${v.join(',')}]`;
}
