'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import AgentConsole, { type Step } from '@/components/AgentConsole';
import Button from '@/components/Button';
import { apiGet } from '@/lib/api';

interface Venture { id: string; name: string }

type DockMode = 'hidden' | 'docked';
const STORAGE_KEY = 'leadrail_dock';
const WIDTH_KEY = 'leadrail_dock_w';
const DEFAULT_WIDTH = 880;
const bareRoutes = ['/login', '/privacy', '/terms', '/data-deletion'];

const METRIC_LABELS: Record<string, string> = {
  leadsFound: 'Leads found', qualified: 'Qualified', drafts: 'Drafts', revealed: 'Revealed',
  emailsSent: 'Emails sent', enrolled: 'Enrolled', copy: 'Copy', deals: 'Deals',
};

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
// stream/composer/tool-cards/approval card, plus a right context column driven
// by AgentConsole's real steps.
export default function AssistantDock() {
  const pathname = usePathname();
  const [mode, setMode] = useState<DockMode>('hidden');
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [brandId, setBrandId] = useState<string | undefined>(undefined);

  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(false);
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

  // Run stats — all derived from real steps, never fabricated.
  const totalSteps = steps.length;
  const toolsOk = steps.filter((s) => s.kind === 'tool' && s.done && s.ok).length;
  const running = steps.filter((s) => 'done' in s && !s.done).length;
  // Reflects a real pending approval surfaced by AgentConsole (needs_approval event).
  const approval = pendingApproval ? 1 : 0;
  // Real per-run domain outcomes, summed from actual tool results (never faked).
  const metrics = steps.reduce((acc, s) => {
    if (s.kind === 'tool' && (s as any).metrics) {
      for (const [k, v] of Object.entries((s as any).metrics as Record<string, number>)) acc[k] = (acc[k] || 0) + v;
    }
    return acc;
  }, {} as Record<string, number>);
  const domainTiles = Object.entries(metrics).filter(([, v]) => v > 0);
  const showContext = width >= 820;

  return (
    <aside
      style={{ width }}
      className="relative hidden h-screen shrink-0 flex-col border-r border-[var(--border-default)] bg-[var(--bg-canvas)] md:flex"
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
          <AgentConsole key={brandId} brandId={brandId} onSteps={(s, b, pa) => { setSteps(s); setBusy(b); setPendingApproval(pa); }} />
        </div>

        {showContext && (
          <div className="w-[300px] shrink-0 overflow-y-auto border-l border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">This run</span>
              {busy && <RunningGlyph />}
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <StatTile label="Steps" value={totalSteps} />
              <StatTile label="Tools ✓" value={toolsOk} />
              <StatTile label="Running" value={running} />
              <StatTile label="Approval" value={approval} accent={approval > 0 ? '#D97706' : undefined} />
            </div>

            {domainTiles.length > 0 && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                {domainTiles.map(([k, v]) => (
                  <StatTile key={k} label={METRIC_LABELS[k] || k} value={v} accent="var(--brand)" />
                ))}
              </div>
            )}

            <div className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Activity</div>
            <div className="mt-2">
              {steps.length === 0 ? (
                <div className="rounded-[10px] border border-dashed border-[var(--border-default)] px-3 py-4 text-center text-[12px] text-[var(--text-muted)]">
                  No activity yet — ask the assistant to start.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {steps.map((s, i) => <ActivityRow key={i} step={s} />)}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 4px drag handle on the right edge */}
      <div
        onPointerDown={startDrag}
        className="absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize bg-transparent hover:bg-[var(--border-strong)]"
      />
    </aside>
  );
}

function StatTile({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded-[10px] bg-[var(--bg-raised)] p-3" style={accent ? { boxShadow: `inset 0 0 0 1px ${accent}` } : undefined}>
      <div className="text-[22px] font-bold leading-none" style={{ color: accent || 'var(--text-primary)' }}>{value}</div>
      <div className="mt-1 text-[11px] text-[var(--text-secondary)]">{label}</div>
    </div>
  );
}

// Reuses the exact spinner markup/classes AgentConsole's StepRow uses.
function RunningGlyph() {
  return (
    <span className="relative flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--brand)] opacity-70" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--brand)]" />
    </span>
  );
}

function ActivityRow({ step }: { step: Step }) {
  const label = step.kind === 'thought' ? step.text : step.kind === 'tool' ? step.label : step.text;
  const done = 'done' in step ? step.done : true;
  const failed = step.kind === 'error' || (step.kind === 'tool' && step.done && step.ok === false);

  let glyph: React.ReactNode;
  let state: string;
  if (failed) { glyph = <span className="text-[var(--status-negative)]">✕</span>; state = 'error'; }
  else if (step.kind === 'tool' && step.done && step.ok) { glyph = <span className="text-[var(--status-positive)]">✓</span>; state = 'done'; }
  else if (!done) { glyph = <RunningGlyph />; state = 'running'; }
  else { glyph = <span className="text-[var(--text-muted)]">·</span>; state = 'done'; }

  return (
    <div className="flex items-center gap-2 text-[13px] text-[var(--text-secondary)]">
      <span className="flex w-3 shrink-0 justify-center">{glyph}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{state}</span>
    </div>
  );
}
