'use client';
import { useEffect, useState, useCallback } from 'react';
import Badge from '@/components/Badge';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Dropdown from '@/components/Dropdown';
import LoadingSpinner from '@/components/LoadingSpinner';
import { apiGet, apiSend } from '@/lib/api';

// Settings -> Models & Providers. Configures the per-account AI provider
// registry (migration 023) that lib/ai/router.ts consults ahead of the
// platform's built-in Zo Ask -> OpenCode -> NIM ladder. Entirely optional:
// with zero providers here, generation keeps using the built-in ladder.

interface Provider {
  id: string;
  name: string;
  kind: string;
  base_url: string | null;
  enabled: boolean;
  has_key: boolean;
  key_preview: string | null;
}

interface Model {
  id: string;
  provider_id: string;
  model_id: string;
  label: string | null;
  tier: 'fast' | 'balanced' | 'heavy';
  good: string[];
  reliable: boolean;
  enabled: boolean;
}

interface Routing {
  account_id: string;
  active_model_id: string | null;
  fallback_chain: string[];
}

interface UsageRow {
  provider_id: string | null;
  model_id: string | null;
  model_label: string | null;
  calls: number;
  ok_calls: number;
  tokens_in: number;
  tokens_out: number;
}

const KIND_OPTIONS = [
  { value: 'openai-compatible', label: 'OpenAI-compatible' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'zoask', label: 'Zo Ask (platform)' },
  { value: 'opencode', label: 'OpenCode (platform)' },
  { value: 'nim', label: 'NVIDIA NIM (platform)' },
  { value: 'gemini', label: 'Gemini (platform)' },
  { value: 'custom', label: 'Custom (OpenAI-shaped)' },
];

const TIER_OPTIONS = [
  { value: 'fast', label: 'Fast' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'heavy', label: 'Heavy' },
];

function AddProviderForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('openai-compatible');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) { setMsg('Name is required'); return; }
    setMsg(null);
    try {
      await apiSend('/api/ai/providers', 'POST', {
        name: name.trim(),
        kind,
        base_url: baseUrl.trim() || undefined,
        api_key: apiKey.trim() || undefined,
      });
      onCreated();
    } catch (e: any) {
      setMsg(e?.message || 'Could not add provider');
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Name" placeholder="e.g. Team OpenAI" value={name} onChange={(e) => setName((e.target as HTMLInputElement).value)} />
        <Dropdown label="Kind" options={KIND_OPTIONS} value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value)} />
        <Input label="Base URL (optional)" placeholder="https://api.openai.com/v1" value={baseUrl} onChange={(e) => setBaseUrl((e.target as HTMLInputElement).value)} />
        <Input label="API key (optional)" type="password" placeholder="sk-…" value={apiKey} onChange={(e) => setApiKey((e.target as HTMLInputElement).value)} />
      </div>
      {msg && <p className="text-xs text-[var(--text-negative)]">{msg}</p>}
      <div className="flex gap-2">
        <Button onClick={submit} className="text-xs">Add provider</Button>
        <Button variant="ghost" onClick={onCancel} className="text-xs">Cancel</Button>
      </div>
    </div>
  );
}

function AddModelForm({ providerId, onCreated, onCancel }: { providerId: string; onCreated: () => void; onCancel: () => void }) {
  const [modelId, setModelId] = useState('');
  const [label, setLabel] = useState('');
  const [tier, setTier] = useState<'fast' | 'balanced' | 'heavy'>('balanced');
  const [msg, setMsg] = useState<string | null>(null);

  async function submit() {
    if (!modelId.trim()) { setMsg('Model id is required'); return; }
    setMsg(null);
    try {
      await apiSend(`/api/ai/providers/${providerId}/models`, 'POST', { model_id: modelId.trim(), label: label.trim() || undefined, tier });
      onCreated();
    } catch (e: any) {
      setMsg(e?.message || 'Could not add model');
    }
  }

  return (
    <div className="space-y-2 rounded-lg bg-[var(--bg-raised)] p-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <Input placeholder="Model id, e.g. gpt-4.1" value={modelId} onChange={(e) => setModelId((e.target as HTMLInputElement).value)} />
        <Input placeholder="Display label (optional)" value={label} onChange={(e) => setLabel((e.target as HTMLInputElement).value)} />
        <Dropdown options={TIER_OPTIONS} value={tier} onChange={(e) => setTier((e.target as HTMLSelectElement).value as any)} />
      </div>
      {msg && <p className="text-xs text-[var(--text-negative)]">{msg}</p>}
      <div className="flex gap-2">
        <Button onClick={submit} className="text-xs">Add model</Button>
        <Button variant="ghost" onClick={onCancel} className="text-xs">Cancel</Button>
      </div>
    </div>
  );
}

export default function ModelsProviders() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Record<string, Model[]>>({});
  const [routing, setRoutingState] = useState<Routing | null>(null);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addingModelFor, setAddingModelFor] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; detail?: string }>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [provRes, routingRes, usageRes] = await Promise.all([
        apiGet<{ providers: Provider[] }>('/api/ai/providers'),
        apiGet<{ routing: Routing | null }>('/api/ai/routing'),
        apiGet<{ usage: UsageRow[] }>('/api/ai/usage'),
      ]);
      setProviders(provRes.providers || []);
      setRoutingState(routingRes.routing);
      setUsage(usageRes.usage || []);
      const modelLists = await Promise.all(
        (provRes.providers || []).map((p) => apiGet<{ models: Model[] }>(`/api/ai/providers/${p.id}/models`).then((r) => [p.id, r.models || []] as const)),
      );
      setModels(Object.fromEntries(modelLists));
    } catch {
      /* surfaced via empty state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggleProvider(p: Provider) {
    try { await apiSend(`/api/ai/providers/${p.id}`, 'PATCH', { enabled: !p.enabled }); load(); }
    catch (e: any) { setMsg({ ok: false, text: e?.message || 'Could not update provider' }); }
  }

  async function removeProvider(p: Provider) {
    try { await apiSend(`/api/ai/providers/${p.id}`, 'DELETE'); load(); }
    catch (e: any) { setMsg({ ok: false, text: e?.message || 'Could not remove provider' }); }
  }

  async function removeModel(providerId: string, modelId: string) {
    try { await apiSend(`/api/ai/providers/${providerId}/models/${modelId}`, 'DELETE'); load(); }
    catch (e: any) { setMsg({ ok: false, text: e?.message || 'Could not remove model' }); }
  }

  async function testProvider(p: Provider) {
    setTesting(p.id);
    setTestResult((prev) => ({ ...prev, [p.id]: undefined as any }));
    try {
      const r = await apiSend<{ ok: boolean; detail?: string }>(`/api/ai/providers/${p.id}/test`, 'POST', {});
      setTestResult((prev) => ({ ...prev, [p.id]: r }));
    } catch (e: any) {
      setTestResult((prev) => ({ ...prev, [p.id]: { ok: false, detail: e?.message } }));
    } finally {
      setTesting(null);
    }
  }

  async function setActive(modelId: string) {
    try {
      await apiSend('/api/ai/routing', 'PUT', { active_model_id: modelId });
      setMsg({ ok: true, text: 'Active model updated.' });
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not set active model' });
    }
  }

  async function toggleFallback(modelId: string) {
    const current = routing?.fallback_chain || [];
    const next = current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId];
    try {
      await apiSend('/api/ai/routing', 'PUT', { fallback_chain: next });
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not update fallback chain' });
    }
  }

  const allModels = Object.values(models).flat();
  const usageFor = (modelId: string | null) => usage.find((u) => u.model_id === modelId);

  return (
    <div className="space-y-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
      <div>
        <h2 className="text-lg font-semibold">Models &amp; providers</h2>
        <p className="text-sm text-[var(--text-secondary)]">
          Optional: bring your own AI provider (OpenAI, Anthropic, or any OpenAI-compatible endpoint) and choose which
          model answers, plus a fallback order. With nothing configured here, LeadRail uses its built-in AI automatically.
        </p>
      </div>

      {msg && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${msg.ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      {loading ? (
        <LoadingSpinner />
      ) : (
        <>
          {providers.length === 0 && !adding && (
            <p className="text-sm text-[var(--text-muted)]">No providers configured — LeadRail is using its built-in AI.</p>
          )}

          <div className="space-y-3">
            {providers.map((p) => {
              const providerModels = models[p.id] || [];
              const result = testResult[p.id];
              return (
                <div key={p.id} className="rounded-lg border border-[var(--border-default)] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold">{p.name}</h3>
                        <Badge tone={p.enabled ? 'green' : 'gray'}>{p.enabled ? 'enabled' : 'disabled'}</Badge>
                        <span className="text-xs text-[var(--text-muted)]">{p.kind}</span>
                      </div>
                      {p.base_url && <p className="mt-0.5 text-xs text-[var(--text-muted)]">{p.base_url}</p>}
                      {p.has_key && <p className="mt-0.5 text-xs text-[var(--text-muted)]">Key: {p.key_preview}</p>}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button variant="ghost" className="text-xs" loading={testing === p.id} onClick={() => testProvider(p)}>Test connection</Button>
                      <Button variant="ghost" className="text-xs" onClick={() => toggleProvider(p)}>{p.enabled ? 'Disable' : 'Enable'}</Button>
                      <Button variant="danger" className="text-xs" onClick={() => removeProvider(p)}>Remove</Button>
                    </div>
                  </div>

                  {result && (
                    <p className={`mt-2 text-xs ${result.ok ? 'text-[var(--text-positive)]' : 'text-[var(--text-negative)]'}`}>
                      {result.ok ? 'Connection OK' : `Failed: ${result.detail || 'unknown error'}`}
                    </p>
                  )}

                  <div className="mt-3 space-y-2">
                    {providerModels.map((m) => {
                      const isActive = routing?.active_model_id === m.id;
                      const inFallback = (routing?.fallback_chain || []).includes(m.id);
                      const u = usageFor(m.id);
                      return (
                        <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[var(--bg-raised)] px-3 py-2 text-sm">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{m.label || m.model_id}</span>
                            <span className="text-xs text-[var(--text-muted)]">{m.model_id}</span>
                            <Badge tone="gray">{m.tier}</Badge>
                            {isActive && <Badge tone="indigo">active</Badge>}
                            {!isActive && inFallback && <Badge tone="blue">fallback</Badge>}
                            {u && <span className="text-xs text-[var(--text-muted)]">{u.calls} calls · {u.tokens_in + u.tokens_out} tokens (30d)</span>}
                          </div>
                          <div className="flex gap-2">
                            <Button variant="ghost" className="text-xs" disabled={isActive} onClick={() => setActive(m.id)}>Set active</Button>
                            <Button variant="ghost" className="text-xs" disabled={isActive} onClick={() => toggleFallback(m.id)}>
                              {inFallback ? 'Remove from fallback' : 'Add to fallback'}
                            </Button>
                            <button onClick={() => removeModel(p.id, m.id)} className="text-xs text-slate-400 hover:text-[var(--text-negative)]">Remove</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {addingModelFor === p.id ? (
                    <div className="mt-3">
                      <AddModelForm providerId={p.id} onCreated={() => { setAddingModelFor(null); load(); }} onCancel={() => setAddingModelFor(null)} />
                    </div>
                  ) : (
                    <Button variant="ghost" className="mt-3 text-xs" onClick={() => setAddingModelFor(p.id)}>+ Add model</Button>
                  )}
                </div>
              );
            })}
          </div>

          {adding ? (
            <AddProviderForm onCreated={() => { setAdding(false); load(); }} onCancel={() => setAdding(false)} />
          ) : (
            <Button variant="secondary" className="text-xs" onClick={() => setAdding(true)}>+ Add provider</Button>
          )}

          {routing?.fallback_chain?.length ? (
            <p className="text-xs text-[var(--text-muted)]">
              Fallback order: {routing.fallback_chain.map((id) => allModels.find((m) => m.id === id)?.label || allModels.find((m) => m.id === id)?.model_id || id).join(' → ')}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
