'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { apiGet, apiSend } from '@/lib/api';

// Header bell + dropdown for in-app notifications (migration
// 034_notifications.sql). Polls unread count/list every ~30s. Mounted into
// AppShell's header — this file only exports the component.

interface NotificationItem {
  id: string;
  type: string | null;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  created_at: string;
}

const POLL_MS = 30_000;

const timeAgo = (iso: string) => {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};

export default function NotificationsBell() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ items: NotificationItem[]; unread: number }>('/api/notifications');
      setItems(res.items || []);
      setUnread(res.unread || 0);
    } catch {
      /* silent — bell just stays at last known state */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  async function openItem(item: NotificationItem) {
    if (!item.read) {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, read: true } : i)));
      setUnread((u) => Math.max(0, u - 1));
      try {
        await apiSend(`/api/notifications/${item.id}`, 'PATCH');
      } catch {
        /* best-effort */
      }
    }
    if (item.link) window.location.href = item.link;
    setOpen(false);
  }

  async function markAll() {
    setItems((prev) => prev.map((i) => ({ ...i, read: true })));
    setUnread(0);
    try {
      await apiSend('/api/notifications/read-all', 'POST');
    } catch {
      /* best-effort */
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        className="relative flex h-9 w-9 items-center justify-center rounded-md text-[var(--text-secondary)] transition hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white"
            style={{ background: 'var(--status-negative)' }}
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-[var(--shadow-pop)]">
          <div className="flex items-center justify-between border-b border-[var(--border-default)] px-4 py-3">
            <span className="text-sm font-semibold text-[var(--text-primary)]">Notifications</span>
            {unread > 0 && (
              <button onClick={markAll} className="text-xs text-[var(--brand)]">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-auto">
            {items.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">No notifications yet.</p>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => openItem(item)}
                  className="flex w-full flex-col items-start gap-0.5 border-b border-[var(--border-default)] px-4 py-3 text-left transition last:border-b-0 hover:bg-[var(--bg-raised)]"
                >
                  <div className="flex w-full items-center gap-2">
                    {!item.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--brand)' }} />}
                    <span className="truncate text-sm font-medium text-[var(--text-primary)]">{item.title}</span>
                  </div>
                  {item.body && <p className="line-clamp-2 text-xs text-[var(--text-secondary)]">{item.body}</p>}
                  <span className="text-[11px] text-[var(--text-muted)]">{timeAgo(item.created_at)}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
