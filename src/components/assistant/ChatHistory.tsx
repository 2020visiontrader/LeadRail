'use client';

// The history surface.
//
// WHY IT EXISTS. `/api/agent/conversations` was built, correct, account-scoped
// — and called by nothing. The only route back to a conversation was a
// localStorage tab (capped at four) or a saved ?c= URL, so closing a tab to
// make room permanently lost the way back to that chat. Twenty-eight
// conversations were sitting in the database, intact and unreachable, while it
// looked like refreshing had deleted them.
//
// Nothing was ever deleted. This is the missing pointer.

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '@/lib/api';
import Button from '@/components/Button';

interface ConversationRow {
  id: string;
  title: string | null;
  updated_at: string | null;
  token_estimate: number | null;
}

interface Page {
  conversations: ConversationRow[];
  nextCursor: string | null;
}

const PAGE_SIZE = 25;

function when(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function ChatHistory({
  open, onClose, onOpenConversation, openIds,
}: {
  open: boolean;
  onClose: () => void;
  /** Called with a conversation id the user wants opened in a tab. */
  onOpenConversation: (id: string, title: string) => void;
  /** Ids already open, so the list can say so rather than opening a duplicate. */
  openIds: string[];
}) {
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  // Guards against an older request landing after a newer one and overwriting
  // it — the classic search race, where typing fast leaves you looking at
  // results for a prefix you already replaced.
  const requestSeq = useRef(0);

  const load = useCallback(async (opts: { cursor?: string | null; q: string; append: boolean }) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setFailed(false);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (opts.cursor) params.set('cursor', opts.cursor);
      if (opts.q.trim()) params.set('q', opts.q.trim());
      const page = await apiGet<Page>(`/api/agent/conversations?${params}`);
      if (seq !== requestSeq.current) return;   // a newer request won
      setRows((prev) => (opts.append ? [...prev, ...page.conversations] : page.conversations));
      setCursor(page.nextCursor);
    } catch {
      if (seq !== requestSeq.current) return;
      // Say it failed rather than rendering an empty list, which would read as
      // "you have no chats" — the exact wrong message given the bug this fixes.
      setFailed(true);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    load({ q: query, append: false });
  }, [open, load]);   // deliberately not `query` — that is debounced below

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => load({ q: query, append: false }), 250);
    return () => clearTimeout(t);
  }, [query, open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-24" onClick={onClose}>
      <div
        className="w-full max-w-2xl overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-surface)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Chat history"
      >
        <div className="border-b border-[var(--border)] p-4">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your chats…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-canvas)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none"
          />
        </div>

        <div className="max-h-[55vh] overflow-y-auto">
          {failed && (
            <div className="p-6 text-center text-sm text-[var(--status-negative)]">
              Couldn’t load your chats just now. Nothing is lost — try again.
              <div className="mt-3">
                <Button variant="secondary" onClick={() => load({ q: query, append: false })}>Retry</Button>
              </div>
            </div>
          )}

          {!failed && !rows.length && !loading && (
            <div className="p-6 text-center text-sm text-[var(--text-secondary)]">
              {query.trim() ? `No chats matching “${query.trim()}”.` : 'No chats yet.'}
            </div>
          )}

          {rows.map((r) => {
            const isOpen = openIds.includes(r.id);
            return (
              <button
                key={r.id}
                onClick={() => { onOpenConversation(r.id, r.title || 'Chat'); onClose(); }}
                className="flex w-full items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3 text-left hover:bg-[var(--bg-canvas)]"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">
                  {r.title || 'Untitled chat'}
                </span>
                <span className="shrink-0 text-xs text-[var(--text-secondary)]">
                  {isOpen ? 'already open' : when(r.updated_at)}
                </span>
              </button>
            );
          })}

          {cursor && !failed && (
            <div className="p-3 text-center">
              <Button
                variant="secondary"
                loading={loading}
                onClick={() => load({ cursor, q: query, append: true })}
              >
                Load older
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
