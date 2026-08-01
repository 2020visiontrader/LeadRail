export async function apiGet<T = any>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `GET ${path} failed`);
  return res.json();
}

export async function apiSend<T = any>(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: any,
  opts?: { timeoutMs?: number },
): Promise<T> {
  // Safety net so the UI can never spin forever if a server-side AI tier stalls.
  // Default is generous (75s) since some AI generations legitimately take ~20s.
  const controller = new AbortController();
  const timeoutMs = opts?.timeoutMs ?? 75_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error('Request timed out — the AI service is slow right now. Try again.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `${method} ${path} failed`);
  return data;
}
