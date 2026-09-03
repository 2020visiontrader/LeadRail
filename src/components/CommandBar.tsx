'use client';
import { useState, useRef, useEffect } from 'react';
import { apiSend } from '@/lib/api';
import Markdown from '@/components/Markdown';

// LeadRail AI — the in-app conversational executor. The operator types a task in
// plain language; the agent loop (server-side) plans, calls LeadRail tools, and
// either answers or asks for approval before anything that spends money or
// changes live state. Internal tool/vendor names are never shown to the user.

interface Proposal { tool: string; title: string; args: Record<string, any>; summary: string; approvalId?: string }
interface AgentResult {
  status: 'done' | 'needs_approval' | 'error';
  message: string;
  proposal?: Proposal;
  conversationId?: string;
}
interface Bubble { role: 'user' | 'ai'; text: string }

// Must stay >= app/api/agent/route.ts's `export const maxDuration = 300`
// (seconds) — that route is the platform's own hard ceiling on a turn, so a
// client abort BELOW it reports a request as failed while the server is
// still legitimately working and will complete. This used to be 90_000: a
// turn that took, say, 150s looked like an error to the operator and then
// answered anyway a few seconds later with nobody watching. 300_000 matches
// the route's ceiling exactly — if the server hasn't responded by then, the
// platform has already killed the route too, so there is nothing left to
// wait for.
const AGENT_REQUEST_TIMEOUT_MS = 300_000;
// Below this, "Working…" reads as normal latency. Past it, plain "Working…"
// starts to read like the UI is stuck — the copy below switches to say the
// turn is still running rather than let the operator infer that on their own.
const LONG_TURN_HINT_MS = 20_000;

const EXAMPLES = [
  'How many leads do I have?',
  'Create a lead-ad campaign for this brand',
  'Show my active campaigns',
];

export default function CommandBar({ ventureName }: { ventureName?: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Bubble[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState('');
  const [longTurn, setLongTurn] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  // The server owns conversation state (Packet 0.2). We hold only the opaque id
  // it issued in the JSON response and echo it back on the next request —
  // including the approve-resume, which reloads its context server-side.
  // Undefined until the first turn completes, so a brand-new command-bar
  // session sends no conversationId at all (never a stale or empty-string one).
  // `log` remains the sole source for what is DISPLAYED; nothing rendered here
  // is ever sent back to the server.
  const conversationIdRef = useRef<string | undefined>(undefined);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [log, busy, proposal]);

  // Flips the "still working" copy on once a turn has run long enough that
  // plain "Working…" would read as stuck. Reset on every new request.
  useEffect(() => {
    if (!busy) { setLongTurn(false); return; }
    const timer = setTimeout(() => setLongTurn(true), LONG_TURN_HINT_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  const brandName = ventureName && ventureName !== 'All Brands' ? ventureName : undefined;

  const handle = (res: AgentResult) => {
    if (typeof res.conversationId === 'string' && res.conversationId) conversationIdRef.current = res.conversationId;
    if (res.status === 'needs_approval' && res.proposal) {
      setProposal(res.proposal);
    } else {
      setProposal(null);
      setLog((l) => [...l, { role: 'ai', text: res.message || 'Done.' }]);
    }
  };

  const send = async (q?: string) => {
    const message = (q ?? text).trim();
    if (!message || busy) return;
    setText(''); setError(''); setProposal(null);
    setLog((l) => [...l, { role: 'user', text: message }]);
    setBusy(true);
    try {
      const res = await apiSend<AgentResult>('/api/agent', 'POST', {
        message,
        brandName,
        ...(conversationIdRef.current ? { conversationId: conversationIdRef.current } : {}),
      }, { timeoutMs: AGENT_REQUEST_TIMEOUT_MS });
      handle(res);
    } catch (e: any) {
      // apiSend's own AbortError message ("Request timed out — the AI
      // service is slow right now. Try again.") already covers a genuine
      // timeout honestly — AGENT_REQUEST_TIMEOUT_MS now matches the server's
      // own maxDuration, so an abort here means the platform killed the
      // route too, not that the client gave up early.
      setError(e?.message || "LeadRail AI couldn't handle that — try rephrasing.");
    } finally { setBusy(false); }
  };

  // approvalId is required by the server gate (Packet 0.1). If the proposal
  // arrived without one, persistence failed upstream — refuse locally rather
  // than firing a request the server will reject.
  const approve = async () => {
    if (!proposal || busy) return;
    if (!proposal.approvalId) {
      setProposal(null);
      setLog((l) => [...l, { role: 'ai', text: 'This action could not be recorded for approval, so it was not run.' }]);
      return;
    }
    setBusy(true); setError('');
    const p = proposal; setProposal(null);
    try {
      const res = await apiSend<AgentResult>('/api/agent', 'POST', {
        approve: { approvalId: p.approvalId, tool: p.tool, args: p.args },
        brandName,
        ...(conversationIdRef.current ? { conversationId: conversationIdRef.current } : {}),
      }, { timeoutMs: AGENT_REQUEST_TIMEOUT_MS });
      handle(res);
    } catch (e: any) {
      setError(e?.message || 'That action could not be completed.');
    } finally { setBusy(false); }
  };

  const decline = () => {
    setProposal(null);
    setLog((l) => [...l, { role: 'ai', text: 'Okay — cancelled. Nothing was run.' }]);
  };

  // "New" starts a genuinely fresh thread: dropping the id means the next
  // request carries no conversationId, so the server starts from empty context.
  const reset = () => { conversationIdRef.current = undefined; setLog([]); setProposal(null); setError(''); setText(''); };

  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 shadow-[var(--shadow-card)]">
      {/* Prompt row */}
      <div className="flex items-center gap-3">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className={`absolute inline-flex h-full w-full rounded-full bg-[var(--brand)] opacity-60 ${busy ? 'animate-ping' : ''}`} />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--brand)]" />
        </span>
        <span className="hidden shrink-0 text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)] sm:block">
          LeadRail AI
        </span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          disabled={busy}
          placeholder={busy ? (longTurn ? 'Still working — complex requests can take a few minutes…' : 'Working…') : 'Ask LeadRail AI — e.g. “create a lead-ad campaign for this brand”'}
          className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none disabled:opacity-60"
        />
        {log.length > 0 && !busy && (
          <button onClick={reset} title="New conversation"
            className="shrink-0 rounded-lg px-2 py-2 text-xs text-[var(--text-muted)] transition hover:text-[var(--text-primary)]">
            New
          </button>
        )}
        <button
          onClick={() => send()}
          disabled={busy || !text.trim()}
          className="shrink-0 rounded-lg bg-[var(--ink)] px-4 py-2 text-sm font-semibold text-[var(--ink-fg)] transition hover:bg-[var(--ink-hover)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Ask ▸'}
        </button>
      </div>

      {/* Example chips (only before first interaction) */}
      {log.length === 0 && !error && !busy && (
        <div className="mt-3 flex flex-wrap gap-2 pl-6">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => send(ex)}
              className="rounded-full border border-[var(--border-strong)] bg-[var(--bg-raised)] px-3 py-1 text-xs text-[var(--text-secondary)] transition hover:border-[var(--brand)] hover:text-[var(--brand)]"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {/* Conversation */}
      {(log.length > 0 || busy) && (
        <div ref={logRef} className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
          {log.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div className={
                m.role === 'user'
                  ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-[var(--ink)] px-3.5 py-2 text-sm text-[var(--ink-fg)]'
                  : 'max-w-[85%] overflow-hidden rounded-2xl rounded-bl-sm border border-[var(--border-default)] bg-[var(--bg-raised)] px-3.5 py-2 text-sm text-[var(--text-primary)]'
              }>
                {m.role === 'user' ? m.text : <Markdown>{m.text}</Markdown>}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-[var(--border-default)] bg-[var(--bg-raised)] px-3.5 py-2 text-sm text-[var(--text-muted)]">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--brand)] border-t-transparent" />
                {longTurn
                  ? 'Still working — this is a longer request, it can take a few minutes.'
                  : 'LeadRail AI is working…'}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Approval gate */}
      {proposal && !busy && (
        <div className="mt-3 animate-fade-in rounded-xl border border-[var(--status-warning)]/40 bg-[var(--status-warning-soft,var(--bg-raised))] p-3.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--status-warning)]">Confirm before running</p>
          <p className="mt-1 text-sm text-[var(--text-primary)]">{proposal.summary}</p>
          <div className="mt-3 flex gap-2">
            <button onClick={approve}
              className="rounded-lg bg-[var(--ink)] px-4 py-2 text-sm font-semibold text-[var(--ink-fg)] transition hover:bg-[var(--ink-hover)]">
              Approve &amp; run
            </button>
            <button onClick={decline}
              className="rounded-lg border border-[var(--border-strong)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]">
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-md border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-3 py-2 text-sm text-[var(--status-negative)]">
          {error}
        </p>
      )}
    </div>
  );
}
