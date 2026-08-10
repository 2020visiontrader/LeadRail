'use client';
import { useEffect, useState, useCallback } from 'react';
import Badge from '@/components/Badge';
import LoadingSpinner from '@/components/LoadingSpinner';
import Button from '@/components/Button';
import Input from '@/components/Input';
import { apiGet, apiSend } from '@/lib/api';
import SenderProfiles from '@/components/SenderProfiles';
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

interface PlatformInfo {
  label: string;
  desc: string;
  requiresToken: boolean;
  tokenLabel: string;
  helpUrl: string;
  helpText: string;
  validatorProvider: string;
  oauth?: string;
}

const PLATFORMS: Record<string, PlatformInfo> = {
  supabase: { label: 'Supabase', desc: 'Database & auth', requiresToken: false, tokenLabel: '', helpUrl: '', helpText: '', validatorProvider: '' },
  apollo: { label: 'Apollo', desc: 'Lead sourcing & enrichment', requiresToken: false, tokenLabel: '', helpUrl: '', helpText: '', validatorProvider: '' },
  opencode: { label: 'OpenCode Go (DeepSeek V4 Pro)', desc: 'AI text + chat generation', requiresToken: false, tokenLabel: '', helpUrl: 'https://opencode.ai/auth', helpText: 'Set OPENCODE_API_KEY. Powers sequence/inbox chat, outreach, content, template refine, and plain-language lead search via DeepSeek V4 Pro on the OpenCode Go subscription.', validatorProvider: '' },
  gemini: { label: 'Gemini (Nano Banana)', desc: 'AI image generation', requiresToken: false, tokenLabel: '', helpUrl: '', helpText: '', validatorProvider: '' },
  brevo: { label: 'Brevo', desc: 'Email delivery', requiresToken: false, tokenLabel: '', helpUrl: '', helpText: '', validatorProvider: '' },
  resend: { label: 'Resend', desc: 'Email + newsletters', requiresToken: true, tokenLabel: 'Resend API key', helpUrl: 'https://resend.com/api-keys', helpText: 'Create a Full access key at Resend → API Keys (send-only keys can send but cannot list/read emails). Paste it here.', validatorProvider: 'resend' },
  postiz: { label: 'Postiz', desc: 'Social publishing — 8 platforms unified', requiresToken: true, tokenLabel: 'Postiz API key', helpUrl: 'https://app.postiz.io/settings/api', helpText: 'Sign up at Postiz → Settings → API. One key covers Instagram, TikTok, LinkedIn, X, Facebook, Threads, Reddit, YouTube.', validatorProvider: 'postiz' },
  google_ads: { label: 'Google Ads', desc: 'Search & display campaigns', requiresToken: false, tokenLabel: '', helpUrl: '', helpText: '', validatorProvider: '' },
  nim: { label: 'NVIDIA NIM', desc: 'AI generation (alt)', requiresToken: false, tokenLabel: '', helpUrl: '', helpText: '', validatorProvider: '' },
  notion: { label: 'Notion', desc: 'Read notes & docs into the assistant', requiresToken: false, tokenLabel: '', helpUrl: 'https://www.notion.so/my-integrations', helpText: 'Add a Notion internal integration secret (NOTION_API_KEY) to connect.', validatorProvider: '' },
  google_drive: { label: 'Google Drive', desc: 'Search files & docs into the assistant', requiresToken: false, tokenLabel: '', helpUrl: '', helpText: '', validatorProvider: '' },
};

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

// ---- Client-facing social connections ----
// Users connect THEIR OWN accounts via OAuth into LeadRail's apps. No app IDs,
// no env vars, no backend service names — that's the Postiz/Buffer model.
// Multi-account: each platform card lists every connected account + "Add another".
function ClientConnections({ connections, onChange }: { connections: Connection[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  const accountsFor = (key: string) =>
    connections.filter((c) => c.provider === key && c.status === 'connected');

  async function disconnect(provider: string, externalId: string) {
    setBusy(externalId);
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
                    <li key={c.external_id || c.provider} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
                      <span className="truncate">{c.username ? `@${c.username}` : c.display_name || c.external_id}</span>
                      <button
                        onClick={() => disconnect(s.key, String(c.external_id))}
                        disabled={busy === c.external_id}
                        className="ml-2 shrink-0 text-xs text-slate-400 hover:text-red-600"
                      >
                        {busy === c.external_id ? '…' : 'Disconnect'}
                      </button>
                    </li>
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
    </div>
  );
}

export default function Settings() {
  const [envStatus, setEnvStatus] = useState<Record<string, boolean>>({});
  const [connections, setConnections] = useState<Connection[]>([]);
  const [dbReady, setDbReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const accountId = '00000000-0000-0000-0000-0000000000b1';

  // Role gate: only the platform owner sees the backend integration hub
  // (Supabase, Apollo, AI providers, email, Postiz master key). Clients see
  // per-account social connections only — never the platform's tech stack.
  useEffect(() => {
    fetch('/api/auth/me', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setIsOwner(d?.role === 'owner'))
      .catch(() => setIsOwner(false));
  }, []);

  const [showConnect, setShowConnect] = useState<string | null>(null);
  const [tokenValue, setTokenValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    apiGet(`/api/integrations?accountId=${accountId}`)
      .then((r) => {
        setEnvStatus(r.env || {});
        setConnections(r.connections || []);
        setDbReady(r.db_ready);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  // Surface the Meta OAuth redirect result, then clean the URL.
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

  function isConnected(platform: string): boolean {
    const env = envStatus[platform] ?? false;
    const conn = connections.find((c) => c.provider === platform && c.status === 'connected');
    return env || !!conn;
  }

  function connectedVia(platform: string): string | null {
    if (envStatus[platform]) return 'env var';
    const conn = connections.find((c) => c.provider === platform && c.status === 'connected');
    return conn ? `account token (${conn.meta?.platform_name || 'validated'})` : null;
  }

  async function handleConnect(platform: string) {
    setBusy(true);
    setFeedback(null);
    const info = PLATFORMS[platform];
    try {
      const result = await apiSend('/api/integrations/validate', 'POST', {
        provider: info.validatorProvider,
        token: tokenValue,
        accountId,
      });
      setFeedback({ ok: true, msg: `Connected to ${result.external_name} (${info.label})` });
      setShowConnect(null);
      setTokenValue('');
      load();
    } catch (e: any) {
      setFeedback({ ok: false, msg: e?.message || 'Validation failed' });
    } finally {
      setBusy(false);
    }
  }

  const ready = !loading && isOwner !== null;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{isOwner ? 'Settings' : 'Connections'}</h1>
        <p className="text-sm text-slate-500">
          {isOwner ? 'Integration hub — platform backend + per-account connections' : 'Connect your social accounts'}
        </p>
      </div>

      {!ready ? (
        <LoadingSpinner />
      ) : (
        <>
          {feedback && showConnect === null && (
            <div className={`rounded-lg border px-4 py-3 text-sm ${feedback.ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
              {feedback.msg}
            </div>
          )}

          {/* SOCIAL CONNECTIONS — shown to everyone (per-account OAuth, no backend) */}
          <ClientConnections connections={connections} onChange={load} />

          {/* OWNER-ONLY — backend integration hub */}
          {isOwner && (
            <div className="border-t border-slate-200 pt-6">
              <h2 className="text-lg font-semibold">Platform backend</h2>
              <p className="mb-4 text-sm text-slate-500">Admin only — never shown to client accounts.</p>
            </div>
          )}

          {isOwner && (
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
            Database: {dbReady ? <Badge tone="green">connected</Badge> : <Badge tone="amber">not configured</Badge>}
          </div>
          )}

          {isOwner && (
          <div className="grid gap-4 sm:grid-cols-2">
            {Object.entries(PLATFORMS).map(([key, info]) => {
              const on = isConnected(key);
              const via = connectedVia(key);
              return (
                <div key={key} className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-semibold">{info.label}</h3>
                      <p className="text-sm text-slate-500">{info.desc}</p>
                      {via && <p className="mt-1 text-xs text-slate-400">{via}</p>}
                    </div>
                    <Badge tone={on ? 'green' : 'gray'}>{on ? 'connected' : 'off'}</Badge>
                  </div>

                  {info.oauth && (
                    <a href={info.oauth} className="w-full">
                      <Button variant={on ? 'ghost' : 'secondary'} className="w-full text-xs">
                        {on ? 'Reconnect Facebook' : 'Connect with Facebook'}
                      </Button>
                    </a>
                  )}

                  {info.requiresToken && !on && showConnect !== key && (
                    <Button variant="secondary" className="w-full text-xs" onClick={() => { setShowConnect(key); setTokenValue(''); setFeedback(null); }}>
                      + Connect {info.label}
                    </Button>
                  )}

                  {info.requiresToken && on && showConnect !== key && (
                    <Button variant="ghost" className="w-full text-xs" onClick={() => { setShowConnect(key); setTokenValue(''); setFeedback(null); }}>
                      Reconnect
                    </Button>
                  )}

                  {showConnect === key && (
                    <div className="space-y-3 rounded-lg bg-slate-50 p-3">
                      <p className="text-xs text-slate-600">{info.helpText}</p>
                      <a href={info.helpUrl} target="_blank" rel="noopener" className="text-xs text-blue-600 underline">
                        Open setup guide →
                      </a>
                      <Input
                        type="password"
                        label={info.tokenLabel}
                        placeholder="Paste your token or API key…"
                        value={tokenValue}
                        onChange={(e) => { setTokenValue((e.target as HTMLInputElement).value); setFeedback(null); }}
                      />
                      {feedback && (
                        <p className={`text-xs ${feedback.ok ? 'text-green-600' : 'text-red-600'}`}>
                          {feedback.msg}
                        </p>
                      )}
                      <div className="flex gap-2">
                        <Button onClick={() => handleConnect(key)} loading={busy} disabled={!tokenValue.trim()} className="flex-1 text-xs">
                          Validate & Connect
                        </Button>
                        <Button variant="ghost" onClick={() => { setShowConnect(null); setFeedback(null); }} className="text-xs">
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          )}

          {isOwner && (
          <p className="text-xs text-slate-400">
            Env vars set: {Object.entries(envStatus).filter(([,v]) => v).map(([k]) => PLATFORMS[k]?.label || k).join(', ') || 'none'}<br />
            Per-account connections: {connections.filter((c) => c.status === 'connected').map((c) => PLATFORMS[c.provider]?.label || c.provider).join(', ') || 'none'}<br />
            Recommended: use <strong>Postiz</strong> for all social platforms (one key, 8 platforms). Tokens validated live against each platform's API.
          </p>
          )}

          <SenderProfiles />

          <DataPrivacySection />
        </>
      )}
    </div>
  );
}
