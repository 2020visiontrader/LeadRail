'use client';
import { useCallback, useEffect, useState } from 'react';
import AgentConsole from '@/components/AgentConsole';

// ============================================================================
// ASSISTANT WORKSPACE — up to 4 simultaneous chats
// ============================================================================
//
// TWO PROBLEMS THIS SOLVES, and they share one root cause.
//
// 1) Reloading the page wiped the chat. The transcript was never lost — it is
//    persisted server-side and /api/agent/conversations/:id will return it — but
//    AgentConsole only rehydrates when it is GIVEN a conversationId, and this
//    page rendered a bare <AgentConsole /> with no props. The id the server
//    assigned lived only in a ref inside the component, so on reload nothing
//    knew which conversation to ask for. The chat looked erased; it was merely
//    unreachable. AgentConsole now reports its id via onConversationId, and this
//    page persists it.
//
// 2) One chat at a time. Long agent runs block the conversation for minutes, so
//    a second question means losing your place in the first.
//
// WHY ALL TABS STAY MOUNTED: the SSE stream lives inside AgentConsole. Unmounting
// an inactive tab would abort its in-flight run — which defeats the point of
// "simultaneous". Inactive panes are hidden with CSS instead, so a background
// chat keeps streaming while you work in another. Four is the cap because each
// pane holds an open SSE connection and a full transcript in memory.
//
// PERSISTENCE: tabs live in localStorage, so a reload restores every open chat,
// not just the active one. The active tab is also mirrored into ?c= so a URL is
// shareable and the back button behaves.

const STORAGE_KEY = 'leadrail.assistant.tabs';
const MAX_TABS = 4;

interface ChatTab {
  /** Stable local key. Survives even before the server assigns a conversation id. */
  key: string;
  /** Server-side conversation id — undefined until the first turn completes. */
  conversationId?: string;
  title: string;
}

function newTab(n: number): ChatTab {
  return { key: `t${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, title: `Chat ${n}` };
}

export default function AssistantPage() {
  const [tabs, setTabs] = useState<ChatTab[]>([]);
  const [activeKey, setActiveKey] = useState<string>('');

  // Restore on mount. A malformed or empty store falls back to a single fresh
  // chat rather than rendering nothing.
  useEffect(() => {
    let restored: ChatTab[] = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) {
        restored = parsed
          .filter((t: any) => t && typeof t.key === 'string')
          .slice(0, MAX_TABS)
          .map((t: any, i: number) => ({
            key: String(t.key),
            conversationId: typeof t.conversationId === 'string' ? t.conversationId : undefined,
            title: typeof t.title === 'string' ? t.title : `Chat ${i + 1}`,
          }));
      }
    } catch { /* corrupt store — start clean rather than crash the page */ }

    const initial = restored.length ? restored : [newTab(1)];
    setTabs(initial);

    // ?c= wins over the stored active tab, so a shared link opens the right chat.
    const wanted = new URLSearchParams(window.location.search).get('c');
    const match = wanted ? initial.find((t) => t.conversationId === wanted) : undefined;
    setActiveKey(match?.key || initial[0].key);
  }, []);

  useEffect(() => {
    if (!tabs.length) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs)); } catch { /* quota/private mode */ }
  }, [tabs]);

  // Mirror the active conversation into the URL without adding history entries —
  // replaceState, so Back still leaves the assistant rather than cycling tabs.
  useEffect(() => {
    const active = tabs.find((t) => t.key === activeKey);
    const url = new URL(window.location.href);
    if (active?.conversationId) url.searchParams.set('c', active.conversationId);
    else url.searchParams.delete('c');
    window.history.replaceState(null, '', url.toString());
  }, [tabs, activeKey]);

  const handleConversationId = useCallback((key: string, id: string | undefined) => {
    setTabs((prev) => prev.map((t) => (t.key === key ? { ...t, conversationId: id } : t)));
  }, []);

  const addTab = () => {
    setTabs((prev) => {
      if (prev.length >= MAX_TABS) return prev;
      const t = newTab(prev.length + 1);
      setActiveKey(t.key);
      return [...prev, t];
    });
  };

  const closeTab = (key: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.key !== key);
      const safe = next.length ? next : [newTab(1)];
      if (key === activeKey) setActiveKey(safe[0].key);
      return safe;
    });
  };

  if (!tabs.length) return null;

  return (
    <div className="flex h-[calc(100vh-7rem)] min-h-0 flex-col gap-3">
      <div className="shrink-0">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Assistant</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Plain-language commands, executed step by step — you approve anything that spends money.
        </p>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1.5" role="tablist" aria-label="Assistant chats">
        {tabs.map((t) => {
          const active = t.key === activeKey;
          return (
            <div
              key={t.key}
              className={`flex items-center gap-1 rounded-lg border px-3 py-1.5 text-[13px] transition ${
                active
                  ? 'border-[var(--ink)] bg-[var(--bg-raised)] font-semibold text-[var(--text-primary)]'
                  : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-raised)]'
              }`}
            >
              <button
                role="tab"
                aria-selected={active}
                onClick={() => setActiveKey(t.key)}
                className="max-w-[14rem] truncate"
              >
                {t.title}
              </button>
              {tabs.length > 1 && (
                <button
                  onClick={() => closeTab(t.key)}
                  aria-label={`Close ${t.title}`}
                  className="rounded px-1 text-[var(--text-muted)] transition hover:text-[var(--text-primary)]"
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
        {tabs.length < MAX_TABS && (
          <button
            onClick={addTab}
            className="rounded-lg border border-dashed border-[var(--border-strong)] px-3 py-1.5 text-[13px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
          >
            + New chat
          </button>
        )}
        <span className="ml-auto text-[12px] text-[var(--text-muted)]">
          {tabs.length} of {MAX_TABS} chats
        </span>
      </div>

      {/* Every tab stays mounted — see the note at the top. Hiding rather than
          unmounting is what lets a background run keep streaming. */}
      <div className="relative min-h-0 flex-1">
        {tabs.map((t) => (
          <div key={t.key} className={t.key === activeKey ? 'h-full' : 'hidden'} role="tabpanel">
            <AgentConsole
              conversationId={t.conversationId}
              onConversationId={(id) => handleConversationId(t.key, id)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
