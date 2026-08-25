'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import LoadingSpinner from '@/components/LoadingSpinner';
import PlatformBackend from '@/components/PlatformBackend';
import Diagnostics from '@/components/Diagnostics';
import ModelsProviders from '@/components/ModelsProviders';
import AiUsage from '@/components/AiUsage';
import McpClients from '@/components/McpClients';
import ActivityFeed from '@/components/ActivityFeed';
import Skills from '@/components/Skills';
import SettingsConsole, { type SettingsGroup } from '@/components/SettingsConsole';
import { IconPlatform, IconActivities, IconLogs, IconModels, IconSkills, IconUsage, IconConnections } from '@/components/icons';

// Owner Admin portal — the one place platform-ops surfaces live: infra/service
// keys (Platform backend), the live request feed (Live activity), and a link
// into the full filterable Logs page. Client accounts never reach this route;
// on a non-owner it renders the same "owners only" notice the Logs page uses.
export default function AdminPage() {
  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [active, setActive] = useState('backend');
  // The OAuth callback lands back here with a result in the query string —
  // it cannot render its own page, so this is where the user finds out what
  // happened. Cleared from the URL once read so a refresh does not repeat it.
  const [oauthMsg, setOauthMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const r = q.get('mcp_oauth');
    if (!r) return;
    const detail = q.get('detail');
    const server = q.get('server');
    const MAP: Record<string, { ok: boolean; text: string }> = {
      connected: { ok: true, text: `${server || 'The server'} is authorized. Press Test to discover its tools.` },
      denied: { ok: false, text: `Authorization was declined${detail ? `: ${detail}` : '.'}` },
      expired: { ok: false, text: 'That authorization link had expired or was already used. Press Connect again.' },
      bad_request: { ok: false, text: 'The authorization server sent an incomplete response.' },
      not_registered: { ok: false, text: 'That connection lost its registration. Press Connect to register again.' },
      exchange_failed: { ok: false, text: `Could not complete the handshake${detail ? `: ${detail}` : '.'}` },
    };
    setOauthMsg(MAP[r] || { ok: false, text: 'Authorization did not complete.' });
    setActive('mcp');
    window.history.replaceState({}, '', '/admin');
  }, []);

  useEffect(() => {
    fetch('/api/auth/me', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setIsOwner(d?.role === 'owner'))
      .catch(() => setIsOwner(false));
  }, []);

  if (isOwner === null) return <LoadingSpinner />;

  if (!isOwner) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-bold text-slate-900">Admin</h1>
        <p className="mt-4 text-sm text-slate-500">This page is available to account owners and admins only.</p>
      </div>
    );
  }

  const groups: SettingsGroup[] = [
    {
      id: 'platform',
      label: 'Platform',
      items: [
        { id: 'backend', label: 'Backend', icon: <IconPlatform /> },
        { id: 'diagnostics', label: 'Diagnostics', icon: <IconActivities /> },
        { id: 'activity', label: 'Live activity', icon: <IconLogs /> },
      ],
    },
    {
      id: 'ai',
      label: 'AI',
      items: [
        { id: 'models', label: 'Providers & models', icon: <IconModels /> },
        { id: 'skills', label: 'Skills', icon: <IconSkills /> },
        { id: 'usage', label: 'Usage', icon: <IconUsage /> },
        { id: 'mcp', label: 'MCP servers', icon: <IconConnections /> },
      ],
    },
  ];

  const META: Record<string, { title: string; description: string }> = {
    backend: { title: 'Backend', description: 'Which service keys and infrastructure this deployment has configured.' },
    diagnostics: { title: 'Diagnostics', description: 'What is reachable right now, and what is failing.' },
    activity: { title: 'Live activity', description: 'The system feed as it happens. Full history is in Logs.' },
    models: {
      title: 'Providers & models',
      description: 'The AI providers this platform routes through and the ladder it falls back down. Not visible to client accounts.',
    },
    skills: {
      title: 'Skills',
      description:
        "Saved guidance that shapes how the assistant writes and decides. A skill's text goes into the system prompt, so every one is screened before it is injected — blocked skills are held back and shown here.",
    },
    usage: { title: 'Usage', description: 'AI calls, latency and failures across the platform.' },
    mcp: { title: 'MCP servers', description: 'External tool servers wired into the assistant.' },
  };

  const meta = META[active] ?? META.backend;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Admin</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Platform operations. Owner only — never shown to client accounts.
        </p>
      </div>

      <SettingsConsole
        groups={groups}
        activeId={active}
        onSelect={setActive}
        title={meta.title}
        description={meta.description}
        actions={
          active === 'activity' ? (
            <Link
              href="/logs"
              className="rounded-md border border-[var(--border-default)] px-3 py-1.5 text-[13px] transition hover:bg-[var(--bg-raised)]"
            >
              Full logs →
            </Link>
          ) : undefined
        }
      >
        {active === 'backend' && <PlatformBackend />}
        {active === 'diagnostics' && <Diagnostics />}
        {active === 'activity' && <div className="h-[560px]"><ActivityFeed /></div>}
        {active === 'models' && <ModelsProviders />}
        {/* Moved here from /settings. A skill's instructions are spliced into
            the assistant's system prompt, above the user's own message — that
            is platform configuration, not a per-account preference, and 341 of
            the catalog's skills came from third-party repositories. */}
        {active === 'skills' && <Skills />}
        {active === 'usage' && <AiUsage />}
        {active === 'mcp' && (
          <div className="space-y-3">
            {oauthMsg && (
              <div className={`rounded-lg border px-3 py-2 text-sm ${oauthMsg.ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
                {oauthMsg.text}
              </div>
            )}
            <McpClients />
          </div>
        )}
      </SettingsConsole>
    </div>
  );
}
