'use client';
import { useEffect, useState, useCallback } from 'react';
import Badge from '@/components/Badge';
import Button from '@/components/Button';
import Input from '@/components/Input';
import Dropdown from '@/components/Dropdown';
import Modal from '@/components/Modal';
import LoadingSpinner from '@/components/LoadingSpinner';
import EmptyState from '@/components/EmptyState';
import { apiGet, apiSend } from '@/lib/api';

// Settings -> MCP servers. Registry of EXTERNAL MCP servers this account has
// connected (migration 026_mcp_clients.sql) — the inverse of LeadRail's own
// MCP server (app/api/mcp/route.ts). Test performs an initialize + tools/list
// handshake (lib/mcp/client.ts) and stores the discovered tool list.
//
// Packet 4: an enabled server's discovered tools ARE now bridged into the
// agent's catalog (lib/capabilities/external-mcp.ts) — they show up as
// approval-required tools the assistant can call, not just a registry. There
// is no UI yet for the per-client `allow_auto` opt-in (migration 044) that
// would let an operator mark a specific server's tools as safe to auto-run;
// today that flag can only be set via a direct PATCH to /api/mcp-clients/:id.

interface McpClient {
  id: string;
  name: string;
  transport: 'http' | 'sse';
  url: string;
  has_auth_header: boolean;
  enabled: boolean;
  /** 'header' (a static Authorization header) or 'oauth'. */
  auth_mode?: string;
  /** True once the OAuth flow completed and a token is stored. */
  oauth_connected?: boolean;
  oauth_expires_at?: string | null;
  last_status: string | null;
  last_checked_at: string | null;
  discovered_tools: { name: string; description?: string }[];
}

const TRANSPORT_OPTIONS = [
  { value: 'http', label: 'HTTP' },
  { value: 'sse', label: 'SSE' },
];

const EMPTY_DRAFT = { name: '', transport: 'http' as 'http' | 'sse', url: '', auth_header: '' };
type Draft = typeof EMPTY_DRAFT;

function statusTone(status: string | null): 'green' | 'red' | 'gray' {
  if (status === 'ok') return 'green';
  if (status === 'error') return 'red';
  return 'gray';
}

export default function McpClients() {
  const [clients, setClients] = useState<McpClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  const [testing, setTesting] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; error?: string; tools?: string[] }>>({});

  const [loadErr, setLoadErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet<{ clients: McpClient[] }>('/api/mcp-clients');
      setClients(res.clients || []);
      setLoadErr(null);
    } catch (e: any) {
      // Never swallowed. An empty list and a failed fetch look identical on
      // screen, and the difference is "you have not added one" versus "this
      // page cannot see what you added" — which sends someone hunting in
      // completely the wrong place.
      setLoadErr(e?.message || 'Could not load registered servers.');
      setClients([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function openCreate() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setFormErr(null);
    setModalOpen(true);
  }

  function openEdit(c: McpClient) {
    setEditingId(c.id);
    setDraft({ name: c.name, transport: c.transport, url: c.url, auth_header: '' });
    setFormErr(null);
    setModalOpen(true);
  }

  async function submit() {
    if (!draft.name.trim()) { setFormErr('Name is required'); return; }
    if (!/^https?:\/\//i.test(draft.url.trim())) { setFormErr('URL must start with http:// or https://'); return; }
    setSaving(true);
    setFormErr(null);
    const payload: Record<string, any> = {
      name: draft.name.trim(),
      transport: draft.transport,
      url: draft.url.trim(),
    };
    if (draft.auth_header.trim()) payload.auth_header = draft.auth_header.trim();
    try {
      if (editingId) {
        await apiSend(`/api/mcp-clients/${editingId}`, 'PATCH', payload);
      } else {
        await apiSend('/api/mcp-clients', 'POST', payload);
      }
      setModalOpen(false);
      await load();
    } catch (e: any) {
      setFormErr(e?.message || 'Could not save MCP server');
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(c: McpClient) {
    try {
      await apiSend(`/api/mcp-clients/${c.id}`, 'PATCH', { enabled: !c.enabled });
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not update server' });
    }
  }

  async function removeClient(c: McpClient) {
    try {
      await apiSend(`/api/mcp-clients/${c.id}`, 'DELETE');
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not remove server' });
    }
  }

  /** Begin the OAuth handshake for a server that needs one.
   *
   *  The whole preparation happens server-side — discovery, registration, PKCE
   *  — and this only receives a URL to send the browser to. Deliberately a
   *  same-tab redirect rather than a popup: the authorization server decides
   *  its own flow (some chain through an identity provider), and a popup that
   *  gets blocked or navigates away strands the user with no way back.
   */
  async function connectOauth(c: McpClient) {
    setConnecting(c.id); setMsg(null);
    try {
      const r = await apiSend<{ authorizeUrl: string }>(`/api/mcp-clients/${c.id}/oauth`, 'POST', {});
      if (!r?.authorizeUrl) throw new Error('No authorization URL was returned.');
      window.location.href = r.authorizeUrl;
    } catch (e: any) {
      // Discovery failing is the common case and the message says which step
      // and what to do instead, so it is shown verbatim rather than flattened.
      setMsg({ ok: false, text: e?.message || 'Could not start authorization.' });
      setConnecting(null);
    }
  }

  async function disconnectOauth(c: McpClient) {
    try {
      await apiSend(`/api/mcp-clients/${c.id}/oauth`, 'DELETE');
      setMsg({ ok: true, text: `Signed out of ${c.name}. The server stays registered — Connect to authorize again.` });
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || 'Could not sign out.' });
    }
  }

  /** Servers we know the endpoint for, so nobody has to find a URL and guess
   *  a transport. This is the ONLY thing a preset does — it fills the same form
   *  a manual add uses. It does not imply the connection will work: these are
   *  OAuth-protected, and the Connect button is where that is proved. */
  const KNOWN_SERVERS: {
    key: string; name: string; url: string; transport: 'http' | 'sse';
    blurb: string; unlocks: string;
  }[] = [
    {
      key: 'higgsfield',
      name: 'Higgsfield',
      url: 'https://mcp.higgsfield.ai/mcp',
      transport: 'http',
      blurb: 'Video and image generation, over MCP. Higgsfield issues no API key — authorization happens through OAuth, so Add then Connect are two separate steps.',
      unlocks: 'generateBrandVideo, image generation for the content engine',
    },
  ];

  /** Registered servers that are NOT already shown as a named connector card.
   *  Rendering one twice reads as two connections, and the second copy is the
   *  one people press Remove on. */
  const others = clients.filter((c) => !KNOWN_SERVERS.some((k) => {
    try { return new URL(c.url).host === new URL(k.url).host; } catch { return false; }
  }));

  async function addKnown(preset: (typeof KNOWN_SERVERS)[number]) {
    const existing = clients.find((c) => {
      try { return new URL(c.url).host === new URL(preset.url).host; } catch { return false; }
    });
    if (existing) {
      setMsg({ ok: true, text: `${preset.name} is already registered — press Connect on it below.` });
      return;
    }
    setSaving(true); setMsg(null);
    try {
      await apiSend('/api/mcp-clients', 'POST', {
        name: preset.name, transport: preset.transport, url: preset.url,
      });
      setMsg({ ok: true, text: `${preset.name} registered. Press Connect to authorize it.` });
      load();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || `Could not register ${preset.name}.` });
    } finally {
      setSaving(false);
    }
  }

  async function testClient(c: McpClient) {
    setTesting(c.id);
    setTestResult((prev) => ({ ...prev, [c.id]: undefined as any }));
    try {
      const r = await apiSend<{ ok: boolean; error?: string; tools?: string[] }>(`/api/mcp-clients/${c.id}/test`, 'POST', {});
      setTestResult((prev) => ({ ...prev, [c.id]: r }));
      load();
    } catch (e: any) {
      setTestResult((prev) => ({ ...prev, [c.id]: { ok: false, error: e?.message } }));
    } finally {
      setTesting(null);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">MCP servers</h2>
          <p className="text-sm text-[var(--text-secondary)]">
            Optional: register external MCP servers this account wants to connect to. Test discovers what tools each
            server offers. This is a registry only — LeadRail&apos;s own MCP server (for other apps to call LeadRail)
            is configured separately.
          </p>
        </div>
        <Button variant="secondary" className="shrink-0 text-xs" onClick={openCreate}>+ Add server</Button>
      </div>

      {msg && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${msg.ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {msg.text}
        </div>
      )}

      {/* Named connectors, as cards rather than a row of chips.
          These stay on screen once registered instead of disappearing, because
          a card that vanishes the moment it is added is indistinguishable from
          one that was never built — and "is Higgsfield in here?" is exactly the
          question this section exists to answer at a glance. */}
      <div className="space-y-2">
        {KNOWN_SERVERS.map((k) => {
          const existing = clients.find((c) => {
            try { return new URL(c.url).host === new URL(k.url).host; } catch { return false; }
          });
          const state = !existing
            ? { tone: 'gray' as const, label: 'not added' }
            : existing.oauth_connected
              ? { tone: 'green' as const, label: 'authorized' }
              : { tone: 'amber' as const, label: 'added — not authorized' };
          return (
            <div key={k.key} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{k.name}</span>
                    <Badge tone="gray">MCP</Badge>
                    <Badge tone={state.tone}>{state.label}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-[var(--text-secondary)]">{k.blurb}</p>
                  <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">Unlocks: {k.unlocks}</p>
                  {existing && (
                    <>
                      <p className="mt-1 truncate text-[11px] text-[var(--text-muted)]">{existing.url}</p>
                      {existing.last_checked_at && (
                        <p className="text-[11px] text-[var(--text-muted)]">
                          Last checked: {new Date(existing.last_checked_at).toLocaleString()}
                        </p>
                      )}
                    </>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  {!existing ? (
                    <Button variant="secondary" className="text-xs" loading={saving} onClick={() => addKnown(k)}>Add</Button>
                  ) : (
                    <>
                      <Button variant="secondary" className="text-xs" loading={connecting === existing.id} onClick={() => connectOauth(existing)}>
                        {existing.oauth_connected ? 'Reconnect' : 'Connect'}
                      </Button>
                      {existing.oauth_connected && (
                        <Button variant="ghost" className="text-xs" onClick={() => disconnectOauth(existing)}>Sign out</Button>
                      )}
                      <Button variant="ghost" className="text-xs" loading={testing === existing.id} onClick={() => testClient(existing)}>Test</Button>
                      <Button variant="ghost" className="text-xs" onClick={() => openEdit(existing)}>Edit</Button>
                      <Button variant="ghost" className="text-xs" onClick={() => toggleEnabled(existing)}>{existing.enabled ? 'Disable' : 'Enable'}</Button>
                      <Button variant="danger" className="text-xs" onClick={() => removeClient(existing)}>Remove</Button>
                    </>
                  )}
                </div>
              </div>
              {existing && (() => {
                const r = testResult[existing.id];
                // A 401 here is the expected state before authorization, not a
                // fault — saying "unreachable" for it sends people debugging a
                // network problem that does not exist.
                const unauthorized = !existing.oauth_connected
                  && (r?.error ? /401|unauthorized/i.test(r.error) : existing.last_status === 'error');
                if (unauthorized) {
                  return (
                    <p className="mt-2 text-xs text-[var(--text-muted)]">
                      The server answers but rejects us — expected until Connect completes.
                    </p>
                  );
                }
                if (!r) return null;
                return (
                  <p className={`mt-2 text-xs ${r.ok ? 'text-green-600' : 'text-red-600'}`}>
                    {r.ok
                      ? `Connected — ${r.tools?.length || 0} tool${r.tools?.length === 1 ? '' : 's'} discovered`
                      : `Failed: ${r.error || 'unknown error'}`}
                  </p>
                );
              })()}
            </div>
          );
        })}
      </div>

      {loadErr && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {loadErr} — the list below is empty because the fetch failed, not because nothing is registered.
        </div>
      )}

      {loading ? (
        <LoadingSpinner />
      ) : others.length === 0 ? (
        <EmptyState icon="🔌" title="No other MCP servers registered" hint="The named connectors above cover the servers LeadRail knows. Add a server by URL to register another." />
      ) : (
        <div className="space-y-2">
          {/* Anything already shown as a named connector card above is skipped
              here. Rendering the same server twice reads as two connections,
              and the second copy is the one people press Remove on. */}
          {others.map((c) => {
            const result = testResult[c.id];
            return (
              <div key={c.id} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-raised)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{c.name}</span>
                      <Badge tone="gray">{c.transport}</Badge>
                      <Badge tone={c.enabled ? 'green' : 'gray'}>{c.enabled ? 'enabled' : 'disabled'}</Badge>
                      {c.last_status && <Badge tone={statusTone(c.last_status)}>{c.last_status === 'ok' ? 'reachable' : 'unreachable'}</Badge>}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">{c.url}</p>
                    {c.has_auth_header && <p className="mt-0.5 text-xs text-[var(--text-muted)]">Auth header: configured</p>}
                    {c.last_checked_at && (
                      <p className="mt-0.5 text-xs text-[var(--text-muted)]">Last checked: {new Date(c.last_checked_at).toLocaleString()}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button variant="ghost" className="text-xs" loading={connecting === c.id} onClick={() => connectOauth(c)}>
                      {c.oauth_connected ? 'Reconnect' : 'Connect'}
                    </Button>
                    {c.oauth_connected && (
                      <Button variant="ghost" className="text-xs" onClick={() => disconnectOauth(c)}>Sign out</Button>
                    )}
                    <Button variant="ghost" className="text-xs" loading={testing === c.id} onClick={() => testClient(c)}>Test</Button>
                    <Button variant="ghost" className="text-xs" onClick={() => openEdit(c)}>Edit</Button>
                    <Button variant="ghost" className="text-xs" onClick={() => toggleEnabled(c)}>{c.enabled ? 'Disable' : 'Enable'}</Button>
                    <Button variant="danger" className="text-xs" onClick={() => removeClient(c)}>Remove</Button>
                  </div>
                </div>

                {c.auth_mode === 'oauth' && (
                  <p className={`mt-2 text-xs ${c.oauth_connected ? 'text-green-600' : 'text-[var(--text-muted)]'}`}>
                    {c.oauth_connected
                      ? `Authorized${c.oauth_expires_at ? ` — token renews ${new Date(c.oauth_expires_at).toLocaleString()}` : ''}`
                      : 'Registered but not authorized yet — press Connect.'}
                  </p>
                )}

                {result && (
                  <p className={`mt-2 text-xs ${result.ok ? 'text-green-600' : 'text-red-600'}`}>
                    {result.ok ? `Connected — ${result.tools?.length || 0} tool${result.tools?.length === 1 ? '' : 's'} discovered` : `Failed: ${result.error || 'unknown error'}`}
                  </p>
                )}

                {(c.discovered_tools || []).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {c.discovered_tools.map((t) => (
                      <span key={t.name} title={t.description} className="rounded-full bg-[var(--bg-canvas)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]">
                        {t.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        title={editingId ? 'Edit MCP server' : 'Add MCP server'}
        onClose={() => setModalOpen(false)}
        onSubmit={submit}
        submitLabel={editingId ? 'Save' : 'Add'}
        loading={saving}
        maxWidth="max-w-xl"
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Name" placeholder="e.g. Team Notion MCP" value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: (e.target as HTMLInputElement).value }))} />
            <Dropdown label="Transport" options={TRANSPORT_OPTIONS} value={draft.transport}
              onChange={(e) => setDraft((d) => ({ ...d, transport: (e.target as HTMLSelectElement).value as 'http' | 'sse' }))} />
          </div>
          <Input label="Server URL" placeholder="https://example.com/mcp" value={draft.url}
            onChange={(e) => setDraft((d) => ({ ...d, url: (e.target as HTMLInputElement).value }))} />
          <Input label={editingId ? 'Auth header (leave blank to keep current)' : 'Auth header (optional)'} type="password"
            placeholder="Bearer sk-…" value={draft.auth_header}
            onChange={(e) => setDraft((d) => ({ ...d, auth_header: (e.target as HTMLInputElement).value }))} />
          {formErr && <p className="text-xs text-red-600">{formErr}</p>}
        </div>
      </Modal>
    </div>
  );
}
