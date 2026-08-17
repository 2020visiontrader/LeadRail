'use client';
import { useRef, useState, useEffect } from 'react';
import Button from '@/components/Button';
import Markdown from '@/components/Markdown';

// Live agentic console. Streams the assistant's real reasoning from
// /api/agent/stream and renders it Claude-desktop style: one plain-language
// line per step, a minimal pulsing dot while active that resolves to a check,
// and a clean approval card for actions that spend money. No fake timers —
// every line is a real step the agent actually took.

export type Step =
  | { kind: 'thought'; text: string; done: boolean }
  | { kind: 'tool'; label: string; done: boolean; ok?: boolean; metrics?: Record<string, number> }
  | { kind: 'error'; text: string };

interface Proposal { tool: string; title: string; args: Record<string, any>; summary: string; approvalId?: string }
type Turn = { role: 'user' } & { text: string } | { role: 'assistant'; text: string; steps: Step[] };

// Map internal tool names to plain-language present-tense actions.
const TOOL_VERB: Record<string, string> = {
  listVentures: 'Checking your ventures',
  listAdAccounts: 'Looking up your ad accounts',
  listCampaigns: 'Pulling up your campaigns',
  listConversations: 'Reading recent conversations',
  createCampaign: 'Setting up the campaign',
  launchCampaign: 'Preparing to launch the campaign',
  pauseCampaign: 'Preparing to pause the campaign',
  syncCampaign: 'Refreshing live performance',
  analyzeCampaign: 'Comparing your ad creatives',
  searchNotion: 'Searching your Notion',
  searchDrive: 'Searching your Google Drive',
  // --- added by Packet 2.2-S (social capabilities) ---
  listSocialAccounts: 'Checking your connected social accounts',
  getSocialStatus: 'Checking your social integrations',
  listSocialComments: 'Reading the comments on that post',
  getSocialInsights: 'Pulling that post’s performance',
  draftSocialPost: 'Writing your post',
  publishSocialPost: 'Preparing to publish your post',
  replyToSocialComment: 'Preparing a public reply',
  hideSocialComment: 'Preparing to hide that comment',
  deleteSocialComment: 'Preparing to delete that comment',
  sendSocialMessage: 'Preparing a direct message',
  scheduleSocialPost: 'Preparing to schedule your post',
  listScheduledSocialPosts: 'Checking what’s scheduled',
  getAdBreakdown: 'Breaking down ad performance',
  setAdStatus: 'Preparing to change that ad’s status',
  listSocialAutomations: 'Checking your automatic rules',
  createSocialAutomation: 'Preparing a new automatic rule',
  enableSocialAutomation: 'Preparing to switch on an automatic rule',
  disableSocialAutomation: 'Switching off that automatic rule',
  deleteSocialAutomation: 'Preparing to delete that automatic rule',
  // --- added by Packet 1.3 (verb coverage) ---
  // INVARIANT: every capability in CATALOG_ORDER (lib/capabilities/registry.ts)
  // — including the staged-catalog-only ones — has a key here. verbFor() falls
  // back to the capability title, so a gap degrades quietly instead of failing;
  // when you add a capability, add its verb in the same commit.
  getCampaign: 'Opening that campaign',
  listAdSets: 'Looking through the ad sets',
  listAds: 'Looking through the ads',
  listAssets: 'Gathering your creative assets',
  getInsights: 'Pulling the performance numbers',
  listLeads: 'Going through your leads',
  getLead: 'Opening that lead',
  importAsset: 'Saving that asset',
  readNotionPage: 'Reading that Notion page',
  readDriveFile: 'Reading that file',
  sourceLeads: 'Preparing to find new leads',
  enrichLead: 'Preparing to fill in that lead’s details',
  draftOutreach: 'Writing the outreach',
  sendEmail: 'Preparing to send the email',
  listSequences: 'Checking your follow-up sequences',
  enrollInSequence: 'Preparing to start the follow-ups',
  listStages: 'Checking your pipeline stages',
  createDeal: 'Adding the deal',
  moveDeal: 'Moving the deal along',
  addNote: 'Saving your note',
  updateLeadStatus: 'Updating that lead’s status',
  listTags: 'Checking your tags',
  tagLead: 'Tagging that lead',
  getPersona: 'Reading your brand profile',
  updatePersona: 'Updating your brand profile',
  generateAdCopy: 'Writing ad copy',
  rememberFact: 'Making a note of that',
  forgetFact: 'Forgetting that',
  listFacts: 'Checking what I remember',
  describeTools: 'Working out what I can do here',
};
const verbFor = (tool: string, title: string) => TOOL_VERB[tool] || title || 'Working';

export default function AgentConsole({ brandId, onSteps }: { brandId?: string; onSteps?: (steps: Step[], busy: boolean, pendingApproval: boolean) => void }) {
  const [turns, setTurns] = useState<Array<any>>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  // The server owns conversation state (Packet 0.2). We hold only the opaque id
  // it issued in the trailing `conversation` SSE event and echo it back on the
  // next turn — including the approve-resume, which reloads its context server-
  // side. Undefined until the first turn completes, so a brand-new chat sends
  // no conversationId at all (never a stale or empty-string one).
  const conversationIdRef = useRef<string | undefined>(undefined);
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
        body: JSON.stringify({
          ...payload,
          brandId,
          ...(conversationIdRef.current ? { conversationId: conversationIdRef.current } : {}),
        }),
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
    // Progressive preview of the answer being written. Handled BEFORE the
    // pending-step resolution below on purpose: the "Writing up the answer…"
    // thought must stay pending (spinning) until `final` arrives, so a delta
    // must not trip prevPending. `final` then OVERWRITES t.text with the
    // authoritative message — which is what makes a mid-stream compose failure
    // (fallback to the route pass's draft) render correctly.
    if (e.type === 'final_delta') {
      patchAssistant((t) => { t.text = (t.text || '') + String(e.text ?? ''); });
      return;
    }
    // Trailing event from the route's `finally`: the id the server persisted this
    // turn under. Sent after `final` AND after `needs_approval`, so the resume
    // request below always has it. Handled before patchAssistant so it never
    // resolves a pending step.
    if (e.type === 'conversation') {
      if (typeof e.conversationId === 'string' && e.conversationId) conversationIdRef.current = e.conversationId;
      return;
    }
    patchAssistant((t) => {
      // resolve the previous pending step
      const prevPending = [...t.steps].reverse().find((s: Step) => 'done' in s && !s.done) as Step | undefined;
      if (prevPending && 'done' in prevPending) prevPending.done = true;

      if (e.type === 'thought') t.steps.push({ kind: 'thought', text: e.text, done: false });
      else if (e.type === 'tool') t.steps.push({ kind: 'tool', label: verbFor(e.tool, e.title), done: false });
      else if (e.type === 'observation') {
        const last = [...t.steps].reverse().find((s: Step) => s.kind === 'tool') as any;
        if (last) { last.done = true; last.ok = e.ok; if (e.metrics && Object.keys(e.metrics).length) last.metrics = e.metrics; }
      } else if (e.type === 'final') { t.text = e.message; }
      else if (e.type === 'needs_approval') { setProposal(e.proposal); }
      else if (e.type === 'error') t.steps.push({ kind: 'error', text: e.message });
    });
  }

  const send = () => { const m = input.trim(); if (!m || busy) return; setInput(''); run({ message: m }); };
  // approvalId is required by the server gate (Packet 0.1). If the proposal
  // arrived without one, persistence failed upstream — refuse locally rather
  // than firing a request the server will reject.
  const approve = () => {
    if (!proposal) return;
    if (!proposal.approvalId) {
      patchAssistant((t) => t.steps.push({ kind: 'error', text: 'This action could not be recorded for approval, so it was not run.' }));
      setProposal(null);
      return;
    }
    run({ approve: { approvalId: proposal.approvalId, tool: proposal.tool, args: proposal.args } });
  };

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)]">
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        {turns.length === 0 && (
          <div className="mx-auto mt-10 max-w-md text-center text-sm text-[var(--text-muted)]">
            <div className="mb-2 text-base font-semibold text-[var(--text-primary)]">LeadRail Assistant</div>
            Ask it to find leads, compare your ad creatives, draft outreach, or pull something from Notion or Drive. You’ll see each step it takes.
          </div>
        )}
        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-[var(--brand)] px-4 py-2 text-sm text-white">{t.text}</div>
            </div>
          ) : (
            <div key={i} className="space-y-2">
              {t.steps.length > 0 && (
                <div className="space-y-1.5 rounded-xl bg-[var(--bg-raised)] px-4 py-3">
                  {t.steps.map((s: Step, j: number) => <StepRow key={j} step={s} />)}
                </div>
              )}
              {t.text && (
                <div className="max-w-[85%] animate-fade-in overflow-hidden rounded-2xl bg-[var(--bg-canvas)] px-4 py-2.5 text-sm text-[var(--text-primary)]">
                  <Markdown>{t.text}</Markdown>
                </div>
              )}
            </div>
          ),
        )}
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
