export async function apiGet<T = any>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `GET ${path} failed`);
  return res.json();
}

export async function apiSend<T = any>(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: any): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `${method} ${path} failed`);
  return data;
}
