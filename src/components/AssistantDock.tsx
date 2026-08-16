'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import AgentConsole from '@/components/AgentConsole';
import Button from '@/components/Button';
import { apiGet } from '@/lib/api';

interface Venture { id: string; name: string }

type DockMode = 'hidden' | 'docked';
const STORAGE_KEY = 'leadrail_dock';
const WIDTH_KEY = 'leadrail_dock_w';
const DEFAULT_WIDTH = 880;
const bareRoutes = ['/login', '/privacy', '/terms', '/data-deletion'];

// Shared mode helpers so AppShell's rail launcher and this dock stay in sync
// through localStorage + a custom event (no external state lib / no new deps).
export const DOCK_EVENT = 'leadrail:dock';
export function readDockMode(): DockMode {
  try { return localStorage.getItem(STORAGE_KEY) === 'docked' ? 'docked' : 'hidden'; } catch { return 'hidden'; }
}
export function setDockMode(mode: DockMode) {
  try { localStorage.setItem(STORAGE_KEY, mode); } catch {}
  window.dispatchEvent(new CustomEvent(DOCK_EVENT, { detail: mode }));
}
export function toggleDockMode() {
  setDockMode(readDockMode() === 'docked' ? 'hidden' : 'docked');
}

// Clamp to [560, 1100]; on narrow viewports keep the rail + some content visible.
function clampWidth(w: number): number {
  let max = 1100;
  if (typeof window !== 'undefined' && window.innerWidth < 1200) max = Math.min(1100, window.innerWidth - 260);
  return Math.max(560, Math.min(max, w));
}

// Global retractable assistant dock. Sits between the rail and main content
// (AppShell restructures the flex row); reuses AgentConsole verbatim for the
// stream/composer/tool-cards/approval card.
export default function AssistantDock() {
  const pathname = usePathname();
  const [mode, setMode] = useState<DockMode>('hidden');
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [brandId, setBrandId] = useState<string | undefined>(undefined);

  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const dragOrigin = useRef<{ x: number; w: number } | null>(null);

  // Hydrate from storage after mount (avoids SSR/localStorage mismatch), then
  // stay in sync with the rail launcher and other tabs.
  useEffect(() => {
    setMode(readDockMode());
    try { const raw = localStorage.getItem(WIDTH_KEY); if (raw) setWidth(clampWidth(parseInt(raw, 10))); } catch {}
    const onDock = (e: Event) => setMode((e as CustomEvent<DockMode>).detail);
    const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY) setMode(readDockMode()); };
    window.addEventListener(DOCK_EVENT, onDock);
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener(DOCK_EVENT, onDock); window.removeEventListener('storage', onStorage); };
  }, []);

  // Global ⌘J / Ctrl+J toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault();
        toggleDockMode();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Same venture-fetch pattern as app/assistant/page.tsx.
  useEffect(() => {
    apiGet<{ ventures: Venture[] }>('/api/ventures')
      .then((d) => { const vs = d.ventures || []; setVentures(vs); setBrandId(vs[0]?.id); })
      .catch(() => setVentures([]));
  }, []);

  // Live pointer-drag resize on the dock's right edge. Ref holds the drag origin
  // so moves are cheap; clamp + persist happen once on pointer-up.
  const onDragMove = useCallback((e: PointerEvent) => {
    if (!dragOrigin.current) return;
    const dx = e.clientX - dragOrigin.current.x;
    setWidth(clampWidth(dragOrigin.current.w + dx));
  }, []);
  const onDragUp = useCallback(() => {
    dragOrigin.current = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    setWidth((w) => { const c = clampWidth(w); try { localStorage.setItem(WIDTH_KEY, String(c)); } catch {} return c; });
  }, [onDragMove]);
  const startDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragOrigin.current = { x: e.clientX, w: width };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragUp);
  }, [width, onDragMove, onDragUp]);

  const hide = useCallback(() => setDockMode('hidden'), []);

  if (bareRoutes.some((r) => pathname === r)) return null;
  if (mode !== 'docked') return null;

  return (
    <aside
      className="relative hidden h-screen flex-1 flex-col bg-[var(--bg-canvas)] md:flex"
    >
      <div className="flex h-[52px] shrink-0 items-center gap-3 border-b border-[var(--border-default)] px-4">
        <span className="text-[15px] font-bold tracking-tight text-[var(--text-primary)]" style={{ fontFamily: 'var(--font-display)' }}>Assistant</span>
        {ventures.length > 0 && (
          <select
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            className="rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1 text-[13px] text-[var(--text-primary)]"
          >
            {ventures.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        )}
        <div className="ml-auto">
          <Button variant="ghost" onClick={hide} className="h-8 px-2.5 text-[13px]">
            <kbd className="rounded border border-[var(--border-default)] px-1 text-[11px] text-[var(--text-muted)]">⌘J</kbd>
            Hide
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <AgentConsole key={brandId} brandId={brandId} />
        </div>
      </div>

    </aside>
  );
}
