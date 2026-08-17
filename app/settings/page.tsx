'use client';
import { useEffect, useState, useCallback } from 'react';
import Badge from '@/components/Badge';
import LoadingSpinner from '@/components/LoadingSpinner';
import Button from '@/components/Button';
import Input from '@/components/Input';
import { apiGet, apiSend } from '@/lib/api';
import SenderProfiles from '@/components/SenderProfiles';
import Personas from '@/components/Personas';
import Skills from '@/components/Skills';
import ModelsProviders from '@/components/ModelsProviders';
import Budgets from '@/components/Budgets';
import AiUsage from '@/components/AiUsage';
import McpClients from '@/components/McpClients';
import ScheduledTasks from '@/components/ScheduledTasks';
import Diagnostics from '@/components/Diagnostics';
import Approvals from '@/components/Approvals';
import { SOCIAL_PROVIDERS } from '@/lib/social/providers';

interface Connection {
  provider: string;
  status: string;
  external_id?: string;
  display_name?: string | null;
  username?: string | null;
  meta: Record<string, any>;
  updated_at: string;
}

function DataPrivacySection() {
  const [status, setStatus] = useState<{ scheduled_for: string | null; grace_days: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet('/api/account/delete').then((r) => setStatus(r)).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  async function requestDelete() {
    setBusy(true); setMsg(null);
    try { const r = await apiSend('/api/account/delete', 'POST', { reason }); setMsg(null); setConfirming(false); load(); void r; }
    catch (e: any) { setMsg(e?.message || 'Could not schedule deletion'); }
    finally { setBusy(false); }
  }
  async function cancelDelete() {
    setBusy(true); setMsg(null);
    try { await apiSend('/api/account/delete', 'DELETE'); load(); }
    catch (e: any) { setMsg(e?.message || 'Could not cancel'); }
    finally { setBusy(false); }
  }

  const scheduled = status?.scheduled_for ? new Date(status.scheduled_for) : null;

  return (
    <div className="space-y-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
      <div>
        <h2 className="text-lg font-semibold">Data &amp; privacy</h2>
        <p className="text-sm text-[var(--text-secondary)]">Your data is private to your account. Export or delete it any time.</p>
      </div>

      {scheduled ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          This account is scheduled for permanent deletion on <strong>{scheduled.toLocaleDateString()}</strong>.
          All data and files are erased then. You can still cancel until that date.
          <div className="mt-3">
            <Button variant="secondary" onClick={cancelDelete} loading={busy} className="text-xs">Cancel deletion</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          <a href="/api/account/export">
            <Button variant="secondary" className="text-xs">⬇ Export my data (JSON)</Button>
          </a>
          {!confirming ? (
            <Button variant="danger" className="text-xs" onClick={() => { setConfirming(true); setMsg(null); }}>
              Delete account
            </Button>
          ) : (
            <div className="w-full rounded-lg border border-red-200 bg-red-50 p-4">
              <p className="text-sm font-medium text-red-800">Delete this account and everything in it?</p>
              <p className="mt-1 text-xs text-red-700">
                We schedule a permanent purge {status?.grace_days ?? 30} days out. During that window the account keeps
                working and you can cancel. After it, every contact, venture, message, and uploaded file is
                irreversibly erased. Owner only.
              </p>
              <div className="mt-3">
                <Input label="Reason (optional)" placeholder="Helps us improve" value={reason}
                  onChange={(e) => setReason((e.target as HTMLInputElement).value)} />
              </div>
              <div className="mt-3 flex gap-2">
                <Button variant="danger" className="text-xs" onClick={requestDelete} loading={busy}>Yes, schedule deletion</Button>
                <Button variant="ghost" className="text-xs" onClick={() => setConfirming(false)}>Keep my account</Button>
              </div>
            </div>
          )}
        </div>
      )}
      {msg && <p className="text-xs text-red-600">{msg}</p>}
      <p className="text-xs text-[var(--text-muted)]">
        Files (decks, attachments) are stored in private buckets and served via short-lived signed links — never public.
        See our <a href="/privacy" className="underline">Privacy Policy</a> and <a href="/data-deletion" className="underline">Data Deletion</a> page.
      </p>
    </div>
  );
}

// One connected account, individually identifiable and individually removable.
// Shows only human-facing identity fields — never meta.access_token /
// meta.user_token / secret_ref, which the row objects also carry.
function ConnectionRow({ c, busy, onDisconnect }: { c: Connection; busy: boolean; onDisconnect: () => void }) {
  const primary = c.username ? `@${c.username}` : c.display_name || c.external_id || c.provider;
  // For Instagram the Page it came through is the relationship that governs
  // access, so it is the thing that actually tells two accounts apart.
  const viaPage = typeof c.meta?.via_page_name === 'string' ? c.meta.via_page_name : null;
  const secondary = viaPage
    ? `via ${viaPage}`
    : c.username && c.display_name && c.display_name !== c.username
      ? c.display_name
      : null;
  const showId = c.external_id && c.external_id !== primary;
  return (
    <li className="flex items-start justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1">
        <span className="block truncate">{primary}</span>
        {secondary && <span className="block truncate text-xs text-[var(--text-secondary)]">{secondary}</span>}
        {showId && <span className="block truncate text-xs text-[var(--text-muted)]">ID {c.external_id}</span>}
      </span>
      <button
        onClick={onDisconnect}
        disabled={busy}
        className="ml-2 shrink-0 text-xs text-[var(--text-muted)] hover:text-red-600"
      >
        {busy ? '…' : 'Disconnect'}
      </button>
    </li>
  );
}

// ---- Advertising accounts ----
// Paid-ad platforms the user connects for the Campaigns page. Google Ads OAuth
// isn't wired yet, so it shows as "soon" — an honest placeholder, not a button
// that hits nothing. When the OAuth route ships, flip `live` to true.
const AD_PROVIDERS = [
  { key: 'google_ads', label: 'Google Ads', desc: 'Connect your Google Ads account to launch and track paid campaigns', brand: '#4285F4', live: false, connectPath: '' },
];

function AdAccounts({ connections, onChange }: { connections: Connection[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const accountsFor = (p: string) => connections.filter((c) => c.provider === p && c.status === 'connected');

  async function disconnect(provider: string, externalId?: string) {
    const key = externalId || provider;
    setBusy(key);
    try { await apiSend('/api/social/disconnect', 'POST', { provider, externalId }); onChange(); }
    catch { /* surfaced on next load */ } finally { setBusy(null); }
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Advertising accounts</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        {AD_PROVIDERS.map((s) => {
          const accts = accountsFor(s.key);
          return (
            <div key={s.key} className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold text-white" style={{ backgroundColor: s.brand }}>{s.label.charAt(0)}</span>
                  <div><h3 className="font-semibold">{s.label}</h3><p className="text-sm text-slate-500">{s.desc}</p></div>
                </div>
                <Badge tone={accts.length ? 'green' : s.live ? 'gray' : 'amber'}>
                  {accts.length ? `${accts.length} connected` : s.live ? 'off' : 'soon'}
                </Badge>
              </div>
              {accts.length > 0 && (
                <ul className="space-y-1.5">
                  {accts.map((c) => (
                    <ConnectionRow
                      key={c.external_id || c.provider}
                      c={c}
                      busy={busy === (c.external_id || c.provider)}
                      onDisconnect={() => disconnect(s.key, c.external_id)}
                    />
                  ))}
                </ul>
              )}
              {s.live && s.connectPath ? (
                <a href={s.connectPath} className="w-full">
                  <Button variant={accts.length ? 'ghost' : 'secondary'} className="w-full text-xs">
                    {accts.length ? `+ Add another ${s.label}` : `Connect ${s.label}`}
                  </Button>
                </a>
              ) : (
                <Button variant="ghost" disabled className="w-full cursor-not-allowed text-xs opacity-60">Coming soon</Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Knowledge-source connections ----
// The user connects THEIR OWN Notion and Google Drive. Notion uses a long-lived
// integration secret (paste); Google Drive uses OAuth (click). Both store
// per-account, and the assistant reads from them.
function KnowledgeSources({ connections, onChange }: { connections: Connection[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notionOpen, setNotionOpen] = useState(false);
  const [notionToken, setNotionToken] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Multi-account: a user can connect several Drive accounts / Notion workspaces.
  // Show every row, not just the first one the DB happened to return.
  const accountsFor = (p: string) => connections.filter((c) => c.provider === p && c.status === 'connected');
  const driveAccts = accountsFor('google_drive');
  const notionAccts = accountsFor('notion');

  async function disconnect(provider: string, externalId?: string) {
    const key = externalId || provider;
    setBusy(key);
    try {
      const qs = externalId ? `?externalId=${encodeURIComponent(externalId)}` : '';
      await apiSend(`/api/integrations/${provider}${qs}`, 'DELETE');
      onChange();
    }
    catch { /* surfaced on reload */ } finally { setBusy(null); }
  }

  async function connectNotion() {
    if (!notionToken.trim()) return;
    setBusy('notion'); setMsg(null);
    try {
      const r = await apiSend<{ external_name?: string }>('/api/integrations/validate', 'POST', { provider: 'notion', token: notionToken.trim() });
      setMsg({ ok: true, text: `Notion connected — ${r.external_name || 'workspace'}` });
      setNotionToken(''); setNotionOpen(false); onChange();
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message?.includes('401') ? 'That token was rejected by Notion. Check you copied the full secret and shared a page with the integration.' : (e?.message || 'Could not connect Notion') });
    } finally { setBusy(null); }
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Knowledge sources</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Google Drive — OAuth */}
        <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#1FA463] text-sm font-bold text-white">D</span>
              <div><h3 className="font-semibold">Google Drive</h3><p className="text-sm text-slate-500">Let the assistant search your Drive files</p></div>
            </div>
            <Badge tone={driveAccts.length ? 'green' : 'gray'}>
              {driveAccts.length ? `${driveAccts.length} connected` : 'off'}
            </Badge>
          </div>
          {driveAccts.length > 0 && (
            <ul className="space-y-1.5">
              {driveAccts.map((c) => (
                <ConnectionRow
                  key={c.external_id || c.provider}
                  c={c}
                  busy={busy === (c.external_id || 'google_drive')}
                  onDisconnect={() => disconnect('google_drive', c.external_id)}
                />
              ))}
            </ul>
          )}
          <a href="/api/social/google-drive/connect" className="w-full">
            <Button variant={driveAccts.length ? 'ghost' : 'secondary'} className="w-full text-xs">
              {driveAccts.length ? '+ Add another Google Drive' : 'Connect Google Drive'}
            </Button>
          </a>
        </div>

        {/* Notion — token paste */}
        <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#111111] text-sm font-bold text-white">N</span>
              <div><h3 className="font-semibold">Notion</h3><p className="text-sm text-slate-500">Let the assistant read your Notion pages</p></div>
            </div>
            <Badge tone={notionAccts.length ? 'green' : 'gray'}>
              {notionAccts.length ? `${notionAccts.length} connected` : 'off'}
            </Badge>
          </div>
          {notionAccts.length > 0 && (
            <ul className="space-y-1.5">
              {notionAccts.map((c) => (
                <ConnectionRow
                  key={c.external_id || c.provider}
                  c={c}
                  busy={busy === (c.external_id || 'notion')}
                  onDisconnect={() => disconnect('notion', c.external_id)}
                />
              ))}
            </ul>
          )}
          {notionOpen ? (
            <div className="space-y-2 rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-600">Create an internal integration at <a href="https://www.notion.so/my-integrations" target="_blank" rel="noopener" className="text-blue-600 underline">notion.so/my-integrations</a>, share your pages with it, then paste its secret.</p>
              <Input type="password" label="Notion integration secret" placeholder="ntn_… or secret_…" value={notionToken} onChange={(e) => setNotionToken((e.target as HTMLInputElement).value)} />
              <div className="flex gap-2">
                <Button onClick={connectNotion} loading={busy === 'notion'} disabled={!notionToken.trim()} className="flex-1 text-xs">Connect</Button>
                <Button variant="ghost" onClick={() => { setNotionOpen(false); setMsg(null); }} className="text-xs">Cancel</Button>
              </div>
            </div>
          ) : (
            <Button variant={notionAccts.length ? 'ghost' : 'secondary'} className="w-full text-xs" onClick={() => { setNotionOpen(true); setMsg(null); }}>{notionAccts.length ? '+ Add another Notion workspace' : 'Connect Notion'}</Button>
          )}
        </div>
      </div>
      {msg && <p className={`text-xs ${msg.ok ? 'text-green-600' : 'text-red-600'}`}>{msg.text}</p>}
    </div>
  );
}

// ---- Social connections ----
// Users connect THEIR OWN accounts via OAuth into LeadRail's apps. No app IDs,
// no env vars, no backend service names — that's the Postiz/Buffer model.
// Multi-account: each platform card lists every connected account + "Add another".
function ClientConnections({ connections, onChange }: { connections: Connection[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  const accountsFor = (key: string) =>
    connections.filter((c) => c.provider === key && c.status === 'connected');

  // Targets ONE connection: externalId identifies the individual account row, so
  // removing one of six Instagram accounts leaves the other five connected.
  async function disconnect(provider: string, externalId?: string) {
    setBusy(externalId || provider);
    try {
      await apiSend('/api/social/disconnect', 'POST', { provider, externalId });
      onChange();
    } catch {
      /* surfaced on next load */
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {SOCIAL_PROVIDERS.map((s) => {
          const accts = accountsFor(s.key);
          return (
            <div key={s.key} className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold text-white" style={{ backgroundColor: s.brand }}>
                    {s.label.charAt(0)}
                  </span>
                  <div>
                    <h3 className="font-semibold">{s.label}</h3>
                    <p className="text-sm text-slate-500">{s.desc}</p>
                  </div>
                </div>
                <Badge tone={accts.length ? 'green' : s.live ? 'gray' : 'amber'}>
                  {accts.length ? `${accts.length} connected` : s.live ? 'off' : 'soon'}
                </Badge>
              </div>

              {accts.length > 0 && (
                <ul className="space-y-1.5">
                  {accts.map((c) => (
                    <ConnectionRow
                      key={c.external_id || c.provider}
                      c={c}
                      busy={busy === (c.external_id || c.provider)}
                      onDisconnect={() => disconnect(s.key, c.external_id)}
                    />
                  ))}
                </ul>
              )}

              {s.live ? (
                <a href={s.connectPath} className="w-full">
                  <Button variant={accts.length ? 'ghost' : 'secondary'} className="w-full text-xs">
                    {accts.length ? `+ Add another ${s.label}` : `Connect ${s.label}`}
                  </Button>
                </a>
              ) : (
                <Button variant="ghost" disabled className="w-full cursor-not-allowed text-xs opacity-60">
                  Coming soon
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-slate-400">
        Connect as many accounts as you manage — each appears here for posting. Your login stays with the platform;
        LeadRail only receives permission to manage the accounts you approve, and you can disconnect any time. To add
        a different account you may need to sign into that platform in this browser first.
      </p>

      <div className="border-t border-slate-200 pt-6">
        <AdAccounts connections={connections} onChange={onChange} />
      </div>

      <div className="border-t border-slate-200 pt-6">
        <KnowledgeSources connections={connections} onChange={onChange} />
      </div>
    </div>
  );
}

export default function Settings() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const accountId = '00000000-0000-0000-0000-0000000000b1';

  const load = useCallback(() => {
    setLoading(true);
    apiGet(`/api/integrations?accountId=${accountId}`)
      .then((r) => { setConnections(r.connections || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  // Surface the OAuth redirect result, then clean the URL.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const connected = q.get('connected');
    if (connected === 'facebook' || connected === 'meta') {
      const page = q.get('page') || 'your Page';
      const pages = q.get('pages');
      const ig = q.get('ig');
      const extra = pages && Number(pages) > 1 ? ` (+${Number(pages) - 1} more Page${Number(pages) - 1 > 1 ? 's' : ''})` : '';
      setFeedback({ ok: true, msg: `Facebook connected — ${page}${extra}${ig ? ` · ${ig} Instagram account${Number(ig) > 1 ? 's' : ''} linked` : ''}` });
    } else if (connected === 'instagram') {
      const ig = q.get('ig') || 'account';
      setFeedback({ ok: true, msg: `Instagram connected — @${ig}` });
    } else if (connected === 'google_drive') {
      setFeedback({ ok: true, msg: `Google Drive connected — ${q.get('email') || 'your account'}` });
    } else if (q.get('error')?.startsWith('gdrive')) {
      const map: Record<string, string> = {
        gdrive_not_configured: 'Google Drive sign-in is not configured yet (missing Google OAuth client).',
        gdrive_denied: 'You declined the Google permission request.',
        gdrive_bad_state: 'Security check failed — please try connecting again.',
        gdrive_exchange: 'Could not complete the Google handshake.',
      };
      const code = q.get('error')!;
      const detail = q.get('detail');
      setFeedback({ ok: false, msg: `${map[code] || 'Google Drive connection failed.'}${detail ? ` (${detail})` : ''}` });
    } else if (q.get('error')?.startsWith('meta') || q.get('error')?.startsWith('ig')) {
      const map: Record<string, string> = {
        meta_not_configured: 'Meta app not configured — set META_APP_ID and META_APP_SECRET first.',
        meta_denied: 'You declined the Facebook permission request.',
        meta_bad_state: 'Security check failed — please try connecting again.',
        meta_no_pages: 'No Facebook Page found on that account. Create/manage a Page, then reconnect.',
        meta_exchange: 'Could not complete the Facebook handshake.',
        ig_not_configured: 'Instagram Login not configured yet — set INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET.',
        ig_denied: 'You declined the Instagram permission request.',
        ig_bad_state: 'Security check failed — please try connecting again.',
        ig_no_account: 'No Instagram Business/Creator account found on that login.',
        ig_exchange: 'Could not complete the Instagram handshake.',
      };
      const code = q.get('error')!;
      const detail = q.get('detail');
      setFeedback({ ok: false, msg: `${map[code] || 'Connection failed.'}${detail ? ` (${detail})` : ''}` });
    }
    if (q.has('connected') || q.has('error')) {
      window.history.replaceState({}, '', '/settings');
    }
  }, []);

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Connections</h1>
        <p className="text-sm text-slate-500">
          Connect the social and ad accounts you post from, plus the sources your assistant reads.
        </p>
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : (
        <>
          {feedback && (
            <div className={`rounded-lg border px-4 py-3 text-sm ${feedback.ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
              {feedback.msg}
            </div>
          )}

          <ClientConnections connections={connections} onChange={load} />

          <SenderProfiles />

          <Personas />

          <Skills />

          <ModelsProviders />

          <AiUsage />

          <Budgets />

          <McpClients />

          <ScheduledTasks />

          <Diagnostics />

          <Approvals />

          <DataPrivacySection />
        </>
      )}
    </div>
  );
}
