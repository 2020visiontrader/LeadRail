'use client';
import { useRef, useState, useEffect } from 'react';
import Button from '@/components/Button';

// Live agentic console. Streams the assistant's real reasoning from
// /api/agent/stream and renders it Claude-desktop style: one plain-language
// line per step, a minimal pulsing dot while active that resolves to a check,
// and a clean approval card for actions that spend money. No fake timers —
// every line is a real step the agent actually took.

export type Step =
  | { kind: 'thought'; text: string; done: boolean }
  | { kind: 'tool'; label: string; done: boolean; ok?: boolean; metrics?: Record<string, number> }
  | { kind: 'error'; text: string };

interface Proposal { tool: string; title: string; args: Record<string, any>; summary: string }
type Turn = { role: 'user' } & { text: string } | { role: 'assistant'; text: string; steps: Step[] };

// Map internal tool names to plain-language present-tense actions.
const TOOL_VERB: Record<string, string> = {
  listVentures: 'Checking your ventures',
  listAdAccounts: 'Looking up your ad accounts',
  listCampaigns: 'Pulling up your campaigns',
  listContacts: 'Scanning your contacts',
  listConversations: 'Reading recent conversations',
  createCampaign: 'Setting up the campaign',
  launchCampaign: 'Preparing to launch the campaign',
  pauseCampaign: 'Preparing to pause the campaign',
  syncCampaign: 'Refreshing live performance',
  analyzeCampaign: 'Comparing your ad creatives',
  searchNotion: 'Searching your Notion',
  searchDrive: 'Searching your Google Drive',
};
const verbFor = (tool: string, title: string) => TOOL_VERB[tool] || title || 'Working';

function transcriptToTurns(transcript: any[]): any[] {
  const NUDGES = ['Respond with ONLY', 'You already ran', 'You have enough', 'Stop calling tools'];
  const out: any[] = [];
  for (const m of transcript || []) {
    const content = typeof m?.content === 'string' ? m.content : '';
    if (m?.role === 'user') {
      if (content.startsWith('OBSERVATION:')) continue;
      if (NUDGES.some((n) => content.startsWith(n))) continue;
      out.push({ role: 'user', text: content, steps: [] });
    } else if (m?.role === 'assistant') {
      try {
        const p = JSON.parse(content);
        if (p && p.action === 'final' && p.message) out.push({ role: 'assistant', text: String(p.message), steps: [] });
      } catch { /* non-JSON assistant content — skip */ }
    }
  }
  return out;
}

export default function AgentConsole({ brandId, onSteps }: { brandId?: string; onSteps?: (steps: Step[], busy: boolean, pendingApproval: boolean) => void }) {
  const [turns, setTurns] = useState<Array<any>>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [threads, setThreads] = useState<Array<{ id: string; title: string | null; updated_at: string | null }>>([]);
  const [showThreads, setShowThreads] = useState(false);
  const transcriptRef = useRef<any[]>([]);
  const conversationIdRef = useRef<string | undefined>(undefined);
  const STORE_KEY = 'leadrail.agent.session';

  // Restore the last session on mount so a refresh doesn't wipe the chat, and
  // follow-up turns continue the same server-side conversation (the backend
  // keys persistence + carryover on conversationId).
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORE_KEY);
      if (stored) {
        const { turns: rt, transcript: rtr, conversationId: rid } = JSON.parse(stored);
        if (Array.isArray(rt) && rt.length) setTurns(rt);
        transcriptRef.current = Array.isArray(rtr) ? rtr : [];
        conversationIdRef.current = typeof rid === 'string' ? rid : undefined;
      }
    } catch { /* corrupt/absent store — start fresh */ }
  }, []);

  // Persist after each turn settles. Never write an empty chat (would clobber a
  // restored session before the restore effect's setTurns lands).
  useEffect(() => {
    if (busy || turns.length === 0) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        turns, transcript: transcriptRef.current, conversationId: conversationIdRef.current,
      }));
    } catch { /* quota/serialization — non-fatal */ }
  }, [turns, busy]);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [turns, busy]);

  // Additive, non-breaking: surface the latest assistant turn's real steps to an
  // optional parent (the dock's context column). No effect on this component's UI.
  useEffect(() => {
    const lastAssistant = [...turns].reverse().find((t: any) => t.role === 'assistant');
    onSteps?.((lastAssistant?.steps as Step[]) ?? [], busy, !!proposal);
    // onSteps intentionally omitted from deps: parent passes a fresh closure each
    // render; re-firing only on real step/busy/approval changes avoids an update loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, busy, proposal]);

  async function refreshThreads() {
    try {
      const res = await fetch('/api/agent/conversations', { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) setThreads(data);
      }
    } catch {
      // swallow
    }
  }

  useEffect(() => {
    if (!busy) refreshThreads();
  }, [busy]);

  function newChat() {
    setTurns([]);
    transcriptRef.current = [];
    conversationIdRef.current = undefined;
    setProposal(null);
    setInput('');
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {}
    setShowThreads(false);
  }

  async function openThread(id: string) {
    try {
      const res = await fetch(`/api/agent/conversations/${id}`, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const c = await res.json();
        transcriptRef.current = Array.isArray(c.transcript) ? c.transcript : [];
        conversationIdRef.current = c.id;
        setTurns(transcriptToTurns(transcriptRef.current));
        setProposal(null);
        setShowThreads(false);
        try {
          localStorage.setItem(STORE_KEY, JSON.stringify({
            turns: transcriptToTurns(transcriptRef.current),
            transcript: transcriptRef.current,
            conversationId: c.id,
          }));
        } catch {}
      }
    } catch {
      // swallow
    }
  }

  // Append/patch the trailing assistant turn as events stream in.
  const patchAssistant = (fn: (t: any) => void) =>
    setTurns((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.role === 'assistant') fn(last);
      return next;
    });

  async function run(payload: { message?: string; approve?: any }) {
    setBusy(true);
    setProposal(null);
    if (payload.message) setTurns((p) => [...p, { role: 'user', text: payload.message }]);
    setTurns((p) => [...p, { role: 'assistant', text: '', steps: [] }]);

    let res: Response;
    try {
      res = await fetch('/api/agent/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ ...payload, brandId, transcript: transcriptRef.current, conversationId: conversationIdRef.current }),
      });
    } catch {
      patchAssistant((t) => t.steps.push({ kind: 'error', text: 'Connection failed. Try again.' }));
      setBusy(false); return;
    }
    if (res.status === 401) { window.location.href = '/login'; return; }
    if (!res.body) { patchAssistant((t) => t.steps.push({ kind: 'error', text: 'No response stream.' })); setBusy(false); return; }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() || '';
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        let e: any;
        try { e = JSON.parse(data); } catch { continue; }
        handleEvent(e);
      }
    }
    setBusy(false);
  }

  function handleEvent(e: any) {
    patchAssistant((t) => {
      // resolve the previous pending step
      const prevPending = [...t.steps].reverse().find((s: Step) => 'done' in s && !s.done) as Step | undefined;
      if (prevPending && 'done' in prevPending) prevPending.done = true;

      if (e.type === 'step_start') t.steps.push({ kind: 'thought', text: e.text, done: false });
      else if (e.type === 'thought') t.steps.push({ kind: 'thought', text: e.text, done: false });
      else if (e.type === 'tool') t.steps.push({ kind: 'tool', label: verbFor(e.tool, e.title), done: false });
      else if (e.type === 'observation') {
        const last = [...t.steps].reverse().find((s: Step) => s.kind === 'tool') as any;
        if (last) { last.done = true; last.ok = e.ok; if (e.metrics && Object.keys(e.metrics).length) last.metrics = e.metrics; }
      } else if (e.type === 'token') { t.text = (t.text || '') + e.text; }
      else if (e.type === 'final') {
        // Token streaming already drives the visible text in the normal case;
        // only fall back to the full message here if nothing (or a shorter/
        // stale partial) streamed in — e.g. a client that reconnects mid-turn.
        // `final` is always the source of truth for the transcript, though.
        if (!t.text || t.text.length < e.message.length) t.text = e.message;
        transcriptRef.current = e.transcript || [];
      }
      else if (e.type === 'needs_approval') { transcriptRef.current = e.transcript || []; setProposal(e.proposal); }
      else if (e.type === 'conversation') { if (e.conversationId) conversationIdRef.current = e.conversationId; }
      else if (e.type === 'error') { if (e.transcript) transcriptRef.current = e.transcript; t.steps.push({ kind: 'error', text: e.message }); }
    });
  }

  const send = () => { const m = input.trim(); if (!m || busy) return; setInput(''); run({ message: m }); };
  const approve = () => proposal && run({ approve: { tool: proposal.tool, args: proposal.args } });

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2 border-b border-[var(--border-default)] px-3 py-2 relative">
        <Button variant="secondary" onClick={() => setShowThreads(v => !v)}>
          History
        </Button>
        {showThreads && (
          <div className="absolute left-0 right-0 mt-2 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-lg shadow-[var(--shadow-card)] z-10 w-64">
            {threads.length === 0 ? (
              <div className="px-3 py-2 text-sm text-[var(--text-muted)]">No past chats</div>
            ) : (
              <div className="space-y-1">
                {threads.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => openThread(t.id)}
                    className="w-full text-left px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-canvas)]"
                  >
                    {t.title || 'Untitled chat'}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="ml-auto">
          <Button onClick={newChat}>New chat</Button>
        </div>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        {turns.length === 0 && (
          <div className="mx-auto mt-10 max-w-md text-center text-sm text-[var(--text-muted)]">
            <div className="mb-2 text-base font-semibold text-[var(--text-primary)]">LeadRail Assistant</div>
            Ask it to find leads, compare your ad creatives, draft outreach, or pull something from Notion or Drive. You’ll see each step it takes.
          </div>
        )}
        {turns.map((t, i) => {
          const isLast = i === turns.length - 1;
          const streaming = t.role === 'assistant' && isLast && busy;
          return t.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-[var(--brand)] px-4 py-2 text-sm text-white">{t.text}</div>
            </div>
          ) : (
            <div key={i} className="space-y-2">
              {t.steps.length > 0 && <ThinkingTrace steps={t.steps} busy={streaming} />}
              {t.text && (
                <div className="max-w-[85%] animate-fade-in whitespace-pre-wrap rounded-2xl bg-[var(--bg-canvas)] px-4 py-2.5 text-sm text-[var(--text-primary)]">
                  {t.text}
                  {streaming && <span className="agent-caret" aria-hidden="true">▍</span>}
                </div>
              )}
            </div>
          );
        })}
        {proposal && (
          <div className="animate-fade-in rounded-xl border border-[#D97706] bg-[color-mix(in_srgb,#D97706_8%,transparent)] p-4">
            <div className="text-sm font-semibold text-[var(--text-primary)]">Approval needed</div>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">{proposal.summary}</p>
            <div className="mt-3 flex gap-2">
              <Button onClick={approve} loading={busy}>Approve &amp; run</Button>
              <Button variant="secondary" onClick={() => setProposal(null)}>Cancel</Button>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="flex items-end gap-2 border-t border-[var(--border-default)] p-3">
        <textarea
          rows={2}
          value={input}
          placeholder="Ask LeadRail to do something…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          className="flex-1 resize-none rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--brand)] focus:outline-none"
        />
        <Button loading={busy} onClick={send}>Send</Button>
      </div>
    </div>
  );
}

// Collapsible reasoning trace, Claude-desktop style: expanded and labeled
// "Thinking…" while the turn is actively streaming, then collapses to a quiet
// one-line summary once done. Clicking the summary re-opens the trace so the
// full step-by-step reasoning is still inspectable after the fact.
function ThinkingTrace({ steps, busy }: { steps: Step[]; busy: boolean }) {
  const [open, setOpen] = useState(busy);
  // Track the busy transition so the trace auto-collapses the moment this
  // turn finishes, without clobbering a manual toggle mid-stream.
  const prevBusy = useRef(busy);
  useEffect(() => {
    if (prevBusy.current && !busy) setOpen(false);
    else if (!prevBusy.current && busy) setOpen(true);
    prevBusy.current = busy;
  }, [busy]);

  const n = steps.length;
  const doneLabel = `Worked through it · ${n} step${n === 1 ? '' : 's'}`;
  return (
    <div className="rounded-xl bg-[var(--bg-raised)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      >
        <span className={`agent-chevron ${open ? 'agent-chevron-open' : ''}`} aria-hidden="true">›</span>
        {busy ? 'Thinking…' : doneLabel}
      </button>
      {open && (
        <div className="space-y-1.5 px-4 pb-3">
          {steps.map((s, j) => <StepRow key={j} step={s} />)}
        </div>
      )}
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  if (step.kind === 'error') {
    return <div className="flex items-center gap-2 text-sm text-[var(--status-negative)]"><span>✕</span>{step.text}</div>;
  }
  const text = step.kind === 'thought' ? step.text : step.label;
  const done = 'done' in step ? step.done : true;
  const failed = step.kind === 'tool' && step.ok === false;
  return (
    <div className="flex items-center gap-2.5 text-sm text-[var(--text-secondary)]">
      {failed ? (
        <span className="text-[var(--status-negative)]">✕</span>
      ) : done ? (
        <span className="text-[var(--status-positive)]">✓</span>
      ) : (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--brand)] opacity-70" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--brand)]" />
        </span>
      )}
      <span className={done ? '' : 'text-[var(--text-primary)]'}>{text}{!done && '…'}</span>
    </div>
  );
}