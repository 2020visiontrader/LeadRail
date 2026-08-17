'use client';
import { useEffect, useMemo, useState } from 'react';
import Markdown from '@/components/Markdown';

// ============================================================================
// Example run — a SCRIPTED REPLAY. Not a live model.
// ============================================================================
//
// HONESTY CONTRACT (Packet 11.2). This component exists to *show* what the
// product does, and it must never be mistakable for the product itself:
//
//   1. It accepts NO free-text input. There is no textarea, no prompt box, no
//      "try it" field. The only controls are Approve / Cancel / Replay, which
//      advance a fixed script.
//   2. It makes NO network request. Nothing here reaches /api/agent/stream or
//      any model provider. Every character below is hard-coded.
//   3. It is labelled in the UI as an example, and the venture, campaign and
//      figures are stated to be illustrative.
//
// If a future change adds an input that appears to produce real AI output, that
// change breaks the packet's acceptance criteria and the consumer-protection
// reasoning behind them. Don't.
//
// The event shape below is a faithful subset of `AgentEvent` in
// `lib/agent/loop.ts` (thought | tool | observation | needs_approval |
// final_delta | final), and the projection + visual language mirror
// `src/components/AgentConsole.tsx` so the replay looks like the real console.
//
// SSR / reduced motion: the component renders the COMPLETED end state on the
// server and on first paint. Only after mount, and only when the visitor has
// not asked for reduced motion, does it rewind to step one and play. That means
// the full transcript is in the initial HTML (crawlers and answer engines see
// it) and `prefers-reduced-motion: reduce` gets the finished state with no
// animation, exactly as the packet requires.

type ReplayEvent =
  | { type: 'thought'; text: string }
  | { type: 'tool'; label: string }
  | { type: 'observation'; ok: boolean }
  | { type: 'needs_approval'; summary: string; title: string }
  | { type: 'final_delta'; text: string }
  | { type: 'final'; message: string };

type Step =
  | { kind: 'thought'; text: string; done: boolean }
  | { kind: 'tool'; label: string; done: boolean; ok?: boolean };

// The answer the replay "streams". Markdown, because the real compose pass
// (packet 8.1) writes markdown and `Markdown` renders it in the real console.
const FINAL_MESSAGE = [
  '**Spring Intake — Toronto** is live.',
  '',
  '- Daily budget: **$40.00**',
  '- Ad set, creative and ad were built from the first asset on the campaign',
  '- Status: ACTIVE',
  '',
  'You approved this one, so it is recorded in the audit trail with your name and',
  'the exact arguments that ran. Want me to check the numbers tomorrow morning?',
].join('\n');

// Chunk the answer into streamed deltas the way the compose pass emits them.
function deltaEvents(text: string, size = 26): ReplayEvent[] {
  const out: ReplayEvent[] = [];
  for (let i = 0; i < text.length; i += size) out.push({ type: 'final_delta', text: text.slice(i, i + size) });
  return out;
}

// Step labels are the real plain-language verbs from AgentConsole's TOOL_VERB
// map, for the real capability names in lib/capabilities/*.
const SCRIPT: ReplayEvent[] = [
  { type: 'thought', text: 'Finding which venture that campaign belongs to.' },
  { type: 'tool', label: 'Checking your ventures' },
  { type: 'observation', ok: true },
  { type: 'thought', text: 'Pulling the campaign list for that venture.' },
  { type: 'tool', label: 'Pulling up your campaigns' },
  { type: 'observation', ok: true },
  { type: 'thought', text: 'Refreshing live spend and results before changing anything.' },
  { type: 'tool', label: 'Refreshing live performance' },
  { type: 'observation', ok: true },
  { type: 'thought', text: 'Launching spends real money, so this one stops here and waits for you.' },
  {
    type: 'needs_approval',
    title: 'Launch campaign (SPENDS MONEY)',
    summary: 'Launch “Spring Intake — Toronto” as a live paid Meta campaign at a $40.00 daily budget.',
  },
  { type: 'tool', label: 'Preparing to launch the campaign' },
  { type: 'observation', ok: true },
  { type: 'thought', text: 'Writing up the answer…' },
  ...deltaEvents(FINAL_MESSAGE),
  { type: 'final', message: FINAL_MESSAGE },
];

const APPROVAL_INDEX = SCRIPT.findIndex((e) => e.type === 'needs_approval');

// Same reduction AgentConsole applies to the live SSE stream: each new event
// resolves the previous pending step, an observation closes its tool row, and
// final_delta only appends text (so the "Writing up the answer…" thought keeps
// pulsing until `final` lands).
function project(events: ReplayEvent[]) {
  const steps: Step[] = [];
  let text = '';
  let approvalSummary: { title: string; summary: string } | null = null;
  for (const e of events) {
    if (e.type === 'final_delta') {
      text += e.text;
      continue;
    }
    const pending = [...steps].reverse().find((s) => !s.done);
    if (pending) pending.done = true;

    if (e.type === 'thought') steps.push({ kind: 'thought', text: e.text, done: false });
    else if (e.type === 'tool') steps.push({ kind: 'tool', label: e.label, done: false });
    else if (e.type === 'observation') {
      const lastTool = [...steps].reverse().find((s) => s.kind === 'tool') as Step | undefined;
      if (lastTool && lastTool.kind === 'tool') {
        lastTool.done = true;
        lastTool.ok = e.ok;
      }
    } else if (e.type === 'needs_approval') approvalSummary = { title: e.title, summary: e.summary };
    else if (e.type === 'final') text = e.message;
  }
  return { steps, text, approvalSummary };
}

export default function ExampleRun() {
  // `playing === false` is the server/first-paint state: the finished run.
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(SCRIPT.length);
  const [approved, setApproved] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  // Start the replay only in the browser, and only if motion is welcome.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setPlaying(true);
    setCursor(0);
    setApproved(false);
    setCancelled(false);
  }, []);

  const pausedForApproval = playing && cursor > APPROVAL_INDEX && !approved;
  const finished = playing && cursor >= SCRIPT.length;

  useEffect(() => {
    if (!playing || cancelled || finished || pausedForApproval) return;
    const next = SCRIPT[cursor];
    if (!next) return;
    const delay = next.type === 'final_delta' ? 45 : next.type === 'observation' ? 550 : 850;
    const id = setTimeout(() => setCursor((c) => c + 1), delay);
    return () => clearTimeout(id);
  }, [playing, cursor, cancelled, finished, pausedForApproval]);

  const shown = useMemo(() => SCRIPT.slice(0, playing ? cursor : SCRIPT.length), [playing, cursor]);
  const { steps, text, approvalSummary } = useMemo(() => project(shown), [shown]);

  const replay = () => {
    setPlaying(true);
    setCursor(0);
    setApproved(false);
    setCancelled(false);
  };

  // Approval card state: pending (buttons live) → approved / cancelled. In the
  // static end state it reads as already approved, because the run completed.
  const approvalState: 'pending' | 'approved' | 'cancelled' = cancelled
    ? 'cancelled'
    : !playing || approved
      ? 'approved'
      : 'pending';

  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border-default)] px-4 py-3 sm:px-5">
        <span className="rounded-full border border-[var(--border-strong)] px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
          Example run
        </span>
        <span className="text-[13px] text-[var(--text-muted)]">
          Scripted replay — not a live model. Names and figures are illustrative.
        </span>
        <button
          type="button"
          onClick={replay}
          className="ml-auto rounded-md border border-[var(--border-default)] px-2.5 py-1 text-[12px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
        >
          {playing && !finished && !cancelled ? 'Restart' : 'Replay'}
        </button>
      </div>

      {/* Height reserved so the replay cannot shift the page as steps appear. */}
      <div className="space-y-3 p-4 sm:p-5 md:min-h-[30rem]">
        <div className="flex justify-end">
          <p className="max-w-[85%] rounded-2xl bg-[var(--brand)] px-4 py-2 text-sm text-white">
            Launch the Spring Intake campaign for the Toronto venture at $40 a day.
          </p>
        </div>

        {steps.length > 0 && (
          <div className="space-y-1.5 rounded-xl bg-[var(--bg-raised)] px-4 py-3">
            {steps.map((s, i) => (
              <StepRow key={i} step={s} />
            ))}
          </div>
        )}

        {approvalSummary && (
          <div className="rounded-xl border border-[#D97706] bg-[color-mix(in_srgb,#D97706_8%,transparent)] p-4">
            <div className="text-sm font-semibold text-[var(--text-primary)]">Approval needed</div>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">{approvalSummary.summary}</p>
            {approvalState === 'pending' ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setApproved(true)}
                  className="rounded-md bg-[var(--ink)] px-3 py-1.5 text-[13px] font-semibold text-[var(--ink-fg)] transition hover:opacity-90"
                >
                  Approve &amp; run
                </button>
                <button
                  type="button"
                  onClick={() => setCancelled(true)}
                  className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-[13px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--bg-raised)]"
                >
                  Cancel
                </button>
              </div>
            ) : approvalState === 'approved' ? (
              <p className="mt-3 text-[13px] font-medium text-[var(--status-positive)]">
                ✓ Approved — recorded, then run once with exactly these arguments.
              </p>
            ) : (
              <p className="mt-3 text-[13px] font-medium text-[var(--text-secondary)]">
                ✕ Cancelled — nothing ran, no money was spent, and no message left the platform.
              </p>
            )}
          </div>
        )}

        {!cancelled && text && (
          <div className="max-w-[95%] overflow-hidden rounded-2xl bg-[var(--bg-canvas)] px-4 py-2.5 text-sm text-[var(--text-primary)]">
            <Markdown>{text}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  const text = step.kind === 'thought' ? step.text : step.label;
  const failed = step.kind === 'tool' && step.ok === false;
  return (
    <div className="flex items-start gap-2.5 text-sm text-[var(--text-secondary)]">
      {failed ? (
        <span className="text-[var(--status-negative)]">✕</span>
      ) : step.done ? (
        <span className="text-[var(--status-positive)]">✓</span>
      ) : (
        <span className="relative mt-1.5 flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--brand)] opacity-70" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--brand)]" />
        </span>
      )}
      <span className={step.done ? '' : 'text-[var(--text-primary)]'}>
        {text}
        {!step.done && '…'}
      </span>
    </div>
  );
}
