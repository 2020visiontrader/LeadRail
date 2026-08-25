'use client';
import { useEffect, useState, useCallback } from 'react';
import Badge from '@/components/Badge';
import Button from '@/components/Button';
import Input from '@/components/Input';
import LoadingSpinner from '@/components/LoadingSpinner';
import { apiGet, apiSend } from '@/lib/api';

// Platform backend — the owner/admin infra hub. This is env-var + service
// wiring for the WHOLE platform (Supabase, Apollo, AI providers, email, the
// Postiz master key). It is NEVER shown on a client-facing page — it lives only
// inside the owner Admin portal. Client social/ad/knowledge connections are a
// different surface entirely (app/settings).

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
}

// Backend infra only. Client-connectable services (google_ads, notion,
// google_drive, socials) intentionally do NOT appear here.
const PLATFORMS: Record<string, PlatformInfo> = {
  supabase: { label: 'Supabase', desc: 'Database & auth', requiresToken: false, tokenLabel: '', helpUrl: '', helpText: '', validatorProvider: '' },
  apollo: { label: 'Apollo', desc: 'Lead sourcing & enrichment', requiresToken: false, tokenLabel: '', helpUrl: '', helpText: '', validatorProvider: '' },
  opencode: { label: 'OpenCode Go (DeepSeek V4 Pro)', desc: 'AI text + chat generation', requiresToken: false, tokenLabel: '', helpUrl: 'https://opencode.ai/auth', helpText: 'Set OPENCODE_API_KEY. Powers sequence/inbox chat, outreach, content, template refine, and plain-language lead search via DeepSeek V4 Pro on the OpenCode Go subscription.', validatorProvider: '' },
  gemini: { label: 'Gemini (Nano Banana)', desc: 'AI image generation', requiresToken: false, tokenLabel: '', helpUrl: '', helpText: '', validatorProvider: '' },
  brevo: { label: 'Brevo', desc: 'Email delivery', requiresToken: false, tokenLabel: '', helpUrl: '', helpText: '', validatorProvider: '' },
  resend: { label: 'Resend', desc: 'Email + newsletters', requiresToken: true, tokenLabel: 'Resend API key', helpUrl: 'https://resend.com/api-keys', helpText: 'Create a Full access key at Resend → API Keys (send-only keys can send but cannot list/read emails). Paste it here.', validatorProvider: 'resend' },
  postiz: { label: 'Postiz', desc: 'Social publishing — 8 platforms unified', requiresToken: true, tokenLabel: 'Postiz API key', helpUrl: 'https://app.postiz.io/settings/api', helpText: 'Sign up at Postiz → Settings → API. One key covers Instagram, TikTok, LinkedIn, X, Facebook, Threads, Reddit, YouTube.', validatorProvider: 'postiz' },
  nim: { label: 'NVIDIA NIM', desc: 'AI generation (alt)', requiresToken: false, tokenLabel: '', helpUrl: '', helpText: '', validatorProvider: '' },
};

export default function PlatformBackend() {
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

  // Connections are keyed (account_id, provider, external_id), so even a backend
  // service can hold more than one row. Count them all instead of stopping at the
  // first match, which used to hide every connection after the first.
  const connectionsFor = (platform: string) =>
    connections.filter((c) => c.provider === platform && c.status === 'connected');

  function isConnected(platform: string): boolean {
    const env = envStatus[platform] ?? false;
    return env || connectionsFor(platform).length > 0;
  }

  function connectedVia(platform: string): string | null {
    if (envStatus[platform]) return 'env var';
    const conns = connectionsFor(platform);
    if (!conns.length) return null;
    const names = conns.map((c) => c.meta?.platform_name || c.display_name || c.external_id || 'validated');
    return `account token (${names.join(', ')})`;
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

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Platform backend</h2>
        <p className="text-sm text-[var(--text-secondary)]">Infrastructure and service keys for the whole platform. Admin only — never shown to client accounts.</p>
      </div>

      {feedback && showConnect === null && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${feedback.ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
          {feedback.msg}
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
        Database: {dbReady ? <Badge tone="green">connected</Badge> : <Badge tone="amber">not configured</Badge>}
      </div>

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
                    <p className={`text-xs ${feedback.ok ? 'text-[var(--text-positive)]' : 'text-[var(--text-negative)]'}`}>
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
        Env vars set: {Object.entries(envStatus).filter(([, v]) => v).map(([k]) => PLATFORMS[k]?.label || k).join(', ') || 'none'}<br />
        Per-account connections: {connections.filter((c) => c.status === 'connected').map((c) => PLATFORMS[c.provider]?.label || c.provider).join(', ') || 'none'}<br />
        Recommended: use <strong>Postiz</strong> for all social platforms (one key, 8 platforms). Tokens validated live against each platform's API.
      </p>
    </div>
  );
}
