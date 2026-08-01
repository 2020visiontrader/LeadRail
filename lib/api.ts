// Centralized fetch helpers. Because every page loads data through these, the
// 401 handling here is the single place that catches an expired/invalid session
// and bounces the operator cleanly back to the login gate — instead of leaving
// them stranded on a dashboard of silently-failing widgets.

let redirecting = false;

// On a 401 from any authed API, send the operator to /login, preserving where
// they were (next=) and flagging why (expired=1) so login can explain it.
function handleUnauthorized(): never {
  if (typeof window !== 'undefined' && !redirecting) {
    redirecting = true;
    const here = window.location.pathname + window.location.search;
    window.location.href = `/login?next=${encodeURIComponent(here)}&expired=1`;
  }
  // Throw a sentinel so in-flight callers stop; the redirect is already underway.
  throw new Error('Session expired');
}

export async function apiGet<T = any>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (res.status === 401) handleUnauthorized();
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
  if (res.status === 401) handleUnauthorized();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `${method} ${path} failed`);
  return data;
}
