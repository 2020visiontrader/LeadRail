'use client';
import { useEffect, useState, useCallback } from 'react';
import Badge from '@/components/Badge';
import LoadingSpinner from '@/components/LoadingSpinner';
import Button from '@/components/Button';
import Input from '@/components/Input';
import { apiGet, apiSend } from '@/lib/api';

interface Connection {
  provider: string;
  status: string;
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
  meta: { label: 'Meta (Facebook + Instagram)', desc: 'Post to your Facebook Page + Instagram', requiresToken: false, tokenLabel: '', helpUrl: 'https://developers.facebook.com/apps/', helpText: 'Sign in with Facebook to connect your Page — no token to paste. Requires the LeadRail Meta app (META_APP_ID / META_APP_SECRET) to be set.', validatorProvider: 'meta', oauth: '/api/social/meta/connect' },
  tiktok: { label: 'TikTok', desc: 'Content publishing & analytics', requiresToken: true, tokenLabel: 'TikTok access token', helpUrl: 'https://developers.tiktok.com/apps/', helpText: 'Create a TikTok Developer app → get access token with video.publish + user.info.basic scopes. Paste here.', validatorProvider: 'tiktok' },
  google_ads: { label: 'Google Ads', desc: 'Search & display campaigns', requiresToken: false, tokenLabel: '', helpUrl: '', helpText: '', validatorProvider: '' },
  nim: { label: 'NVIDIA NIM', desc: 'AI generation (alt)', requiresToken: false, tokenLabel: '', helpUrl: '', helpText: '', validatorProvider: '' },
};

export default function Settings() {
  const [envStatus, setEnvStatus] = useState<Record<string, boolean>>({});
  const [connections, setConnections] = useState<Connection[]>([]);
  const [dbReady, setDbReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const accountId = '00000000-0000-0000-0000-0000000000b1';

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
    if (q.get('connected') === 'meta') {
      const page = q.get('page') || 'your Page';
      const ig = q.get('ig');
      setFeedback({ ok: true, msg: `Facebook connected — ${page}${ig ? ` (+ Instagram @${ig})` : ''}` });
    } else if (q.get('error')?.startsWith('meta')) {
      const map: Record<string, string> = {
        meta_not_configured: 'Meta app not configured — set META_APP_ID and META_APP_SECRET first.',
        meta_denied: 'You declined the Facebook permission request.',
        meta_bad_state: 'Security check failed — please try connecting again.',
        meta_no_pages: 'No Facebook Page found on that account. Create/manage a Page, then reconnect.',
        meta_exchange: 'Could not complete the Facebook handshake.',
      };
      const code = q.get('error')!;
      const detail = q.get('detail');
      setFeedback({ ok: false, msg: `${map[code] || 'Facebook connect failed.'}${detail ? ` (${detail})` : ''}` });
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

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-slate-500">Integration hub — connect platforms per-account</p>
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : (
        <>
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
            Database: {dbReady ? <Badge tone="green">connected</Badge> : <Badge tone="amber">not configured</Badge>}
          </div>

          {feedback && showConnect === null && (
            <div className={`rounded-lg border px-4 py-3 text-sm ${feedback.ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
              {feedback.msg}
            </div>
          )}

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

          <p className="text-xs text-slate-400">
            Env vars set: {Object.entries(envStatus).filter(([,v]) => v).map(([k]) => PLATFORMS[k]?.label || k).join(', ') || 'none'}<br />
            Per-account connections: {connections.filter((c) => c.status === 'connected').map((c) => PLATFORMS[c.provider]?.label || c.provider).join(', ') || 'none'}<br />
            Recommended: use <strong>Postiz</strong> for all social platforms (one key, 8 platforms). Tokens validated live against each platform's API.
          </p>
        </>
      )}
    </div>
  );
}
