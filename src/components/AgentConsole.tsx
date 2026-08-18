'use client';
import { useRef, useState, useEffect } from 'react';
import Button from '@/components/Button';
import Markdown from '@/components/Markdown';
import { apiGet, apiSend } from '@/lib/api';

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
  pauseAllSocialAutomations: 'Pausing all automatic social rules',
  resumeAllSocialAutomations: 'Preparing to resume automatic social rules',
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
  // --- added by Packet 2.2 (domain backfill) ---
  listDeals: 'Pulling up your deals',
  getDeal: 'Opening that deal',
  updateDeal: 'Updating that deal',
  deleteDeal: 'Preparing to delete that deal',
  listActivities: 'Checking logged activity',
  logActivity: 'Logging that activity',
  listSegments: 'Checking your saved segments',
  previewSegment: 'Previewing who matches those filters',
  createSegment: 'Saving that segment',
  updateSegment: 'Updating that segment',
  listJourneys: 'Checking your journeys',
  getJourney: 'Opening that journey',
  createJourney: 'Setting up the journey',
  pauseJourney: 'Preparing to pause that journey',
  listCompanies: 'Pulling up your companies',
  getCompany: 'Opening that company',
  createCompany: 'Adding the company',
  linkContactToCompany: 'Linking that lead to the company',
  getOverview: 'Pulling your account overview',
  listForms: 'Checking your forms',
  getForm: 'Opening that form',
  listSubmissions: 'Checking form submissions',
  createForm: 'Setting up the form',
  getBudget: 'Checking your budget settings',
  getBudgetStatus: 'Checking your spend against budget',
  setBudget: 'Updating your budget settings',
  listScheduledTasks: 'Checking your scheduled tasks',
  createScheduledTask: 'Setting up the scheduled task',
  disableScheduledTask: 'Preparing to turn off that scheduled task',
  listIcpProfiles: 'Checking your saved ICP profiles',
  updateIcpProfile: 'Updating that ICP profile',
  globalSearch: 'Searching your account',
  addSuppression: 'Adding that to your suppression list',
  getThread: 'Opening that conversation',
  replyToThread: 'Preparing a reply',
  markRead: 'Marking that conversation',
  // --- added by Packet D1 ---
  getCampaignAnalytics: 'Rolling up campaign spend',
};
const verbFor = (tool: string, title: string) => TOOL_VERB[tool] || title || 'Working';

interface PersonaOption { id: string; name: string; avatar?: string | null }

export default function AgentConsole({ brandId, conversationId, onSteps }: { brandId?: string; conversationId?: string; onSteps?: (steps: Step[], busy: boolean, pendingApproval: boolean) => void }) {
  const [turns, setTurns] = useState<Array<any>>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [compaction, setCompaction] = useState<{ level: 'soft' | 'hard'; tokenEstimate: number } | null>(null);
  const [handingOver, setHandingOver] = useState(false);
  const [personas, setPersonas] = useState<PersonaOption[]>([]);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string | undefined>(undefined);
  // The server owns conversation state (Packet 0.2). We hold only the opaque id
  // it issued in the trailing `conversation` SSE event and echo it back on the
  // next turn — including the approve-resume, which reloads its context server-
  // side. Undefined until the first turn completes, so a brand-new chat sends
  // no conversationId at all (never a stale or empty-string one).
  //
  // Packet 1.2: it can also be seeded from the `conversationId` prop, when the
  // dock reopens an existing chat.
  const conversationIdRef = useRef<string | undefined>(conversationId);
  // Latch: the server re-emits compaction_suggested on EVERY turn once the
  // transcript is over the threshold. The banner is an offer, not a status line
  // — show it once per chat and never again, even if the user dismisses it.
  const compactionShownRef = useRef(false);
  // Set once, by the carryover handoff, and consumed by the very next request.
  // `from` reseeds a fresh chat from the previous one's memo; sending it twice
  // would re-inject the same carryover block into an already-seeded chat.
  const pendingFromRef = useRef<string | undefined>(undefined);
  const endRef = useRef<HTMLDivElement>(null);
  // Auto-scroll to the newest turn — but NOT on mount, and never by moving the
  // PAGE. Two bugs lived in the old one-liner:
  //   1. it ran on first render with zero turns, so opening /assistant landed the
  //      viewport at the bottom of the document and you had to scroll up to see
  //      the composer you were about to type into;
  //   2. plain scrollIntoView() walks up to the nearest scrollable ancestor,
  //      which here is the document, so it dragged the whole page (nav rail
  //      included) instead of just the message list.
  // `block: 'nearest'` scrolls the message list only, and the length guard means
  // an empty chat never scrolls at all.
  useEffect(() => {
    if (turns.length === 0) return;
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [turns, busy]);

  // Mount-time rehydration. The transcript is already on the server (0.2); this
  // just repaints it, so a refresh no longer looks like the chat is gone.
  // Rehydrated assistant turns carry no steps (steps are live-run telemetry, not
  // persisted) and render through the SAME <Markdown> bubble as live ones.
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    apiGet<{ transcript: Array<{ role: string; content: string }> }>(`/api/agent/conversations/${encodeURIComponent(conversationId)}`)
      .then((d) => {
        if (cancelled) return;
        const rows = Array.isArray(d.transcript) ? d.transcript : [];
        setTurns(rows.map((m) => (m.role === 'user'
          ? { role: 'user', text: m.content }
          : { role: 'assistant', text: m.content, steps: [] })));
      })
      .catch(() => { /* best-effort: an empty console is still usable */ });
    return () => { cancelled = true; };
  }, [conversationId]);

  // Fetch available personas on mount. Additive: only populated when the
  // account has created any personas; empty list is normal for new accounts.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ personas: Array<{ id: string; name: string; avatar?: string | null; enabled: boolean }> }>('/api/personas')
      .then((d) => {
        if (cancelled) return;
        // Filter to enabled personas only — mirrors the UI filtering on the personas list page.
        const enabled = (Array.isArray(d.personas) ? d.personas : []).filter((p: any) => p.enabled);
        setPersonas(enabled);
      })
      .catch(() => { /* best-effort: a missing persona list still leaves the console usable */ });
    return () => { cancelled = true; };
  }, []);

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

    // Consumed here, cleared once the request is actually on the wire (below) —
    // so `from` reaches the server at most once. A connection failure leaves it
    // set, because nothing was sent.
    const from = pendingFromRef.current;

    let res: Response;
    try {
      res = await fetch('/api/agent/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          ...payload,
          brandId,
          ...(conversationIdRef.current ? { conversationId: conversationIdRef.current } : {}),
          ...(from ? { from } : {}),
          ...(selectedPersonaId ? { personaId: selectedPersonaId } : {}),
        }),
      });
      if (from) pendingFromRef.current = undefined;
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
    // Trailing event emitted after `final` once the transcript crosses
    // AGENT_SOFT_TOKENS — and re-emitted on every later turn. It's a banner, not
    // a step, so it returns early like the two branches above: falling through
    // would resolve whatever step was left pending and draw a phantom check.
    // The latch makes the offer appear exactly once per chat.
    if (e.type === 'compaction_suggested') {
      if (!compactionShownRef.current && (e.level === 'soft' || e.level === 'hard')) {
        compactionShownRef.current = true;
        setCompaction({ level: e.level, tokenEstimate: Number(e.tokenEstimate) || 0 });
      }
      return;
    }
    patchAssistant((t) => {
      // resolve the previous pending step
      const prevPending = [...t.steps].reverse().find((s: Step) => 'done' in s && !s.done) as Step | undefined;
      if (prevPending && 'done' in prevPending) prevPending.done = true;

      // 'step_start' (from main) is the live "working" line emitted BEFORE the
      // blocking model call, so the trace shows motion during the 3-8s generation
      // window instead of appearing all at once at the end. It renders as a
      // thought; the real 'thought' that follows supersedes it.
      if (e.type === 'step_start') t.steps.push({ kind: 'thought', text: e.text, done: false });
      else if (e.type === 'thought') t.steps.push({ kind: 'thought', text: e.text, done: false });
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

  // Long-chat handoff: distil the current chat into a carryover memo server-side,
  // then start an empty chat that will send `from=<old id>` on its first (and
  // only its first) message. The old conversation is untouched and still listed.
  const startFreshChat = async () => {
    const fromId = conversationIdRef.current;
    if (!fromId || handingOver) return;
    setHandingOver(true);
    try {
      await apiSend('/api/agent/carryover', 'POST', { conversationId: fromId });
    } catch {
      // The memo could not be written; carrying `from` forward would seed the
      // new chat with nothing. Tell the user rather than silently degrading.
      setHandingOver(false);
      patchAssistant((t) => t.steps.push({ kind: 'error', text: 'Could not prepare the handoff. Your chat is unchanged — try again.' }));
      return;
    }
    pendingFromRef.current = fromId;
    conversationIdRef.current = undefined;
    compactionShownRef.current = false; // fresh chat, fresh (future) offer
    setTurns([]);
    setProposal(null);
    setCompaction(null);
    setSelectedPersonaId(undefined); // reset persona for the new chat
    setHandingOver(false);
  };

  return (
    // h-full, not a hardcoded calc(100vh-9rem). The fixed height did not account
    // for the page heading or <main>'s padding, so the console overflowed the
    // viewport and the PAGE scrolled — the workspace shifted while you typed.
    // The parent now owns the height; the message list below is the only
    // scroller, so the composer stays put.
    <div className="flex h-full min-h-0 flex-col rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)]">
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
        {compaction && (
          <div className="animate-fade-in rounded-xl border border-[#D97706] bg-[color-mix(in_srgb,#D97706_8%,transparent)] p-4">
            <div className="text-sm font-semibold text-[var(--text-primary)]">
              {compaction.level === 'hard' ? 'This chat is very long' : 'This chat is getting long'}
            </div>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              {compaction.level === 'hard'
                ? 'I recommend starting a fresh one — I’ll carry the objective, decisions and open tasks over.'
                : 'Start a fresh one and I’ll carry the context over.'}
            </p>
            <div className="mt-3 flex gap-2">
              <Button onClick={startFreshChat} loading={handingOver}>Start a fresh chat</Button>
              <Button variant="secondary" onClick={() => setCompaction(null)}>Not now</Button>
            </div>
          </div>
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

      {/* Persona picker — optional pill-tabs above the composer. Additive, non-breaking:
          only appears when the account has created personas, and omits personaId from
          the request body when the default is selected (maintaining byte-identical requests). */}
      {personas.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-2">
          <button
            onClick={() => setSelectedPersonaId(undefined)}
            className={`inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              !selectedPersonaId
                ? 'bg-[var(--brand)] text-white'
                : 'bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Default
          </button>
          {personas.map((persona) => (
            <button
              key={persona.id}
              onClick={() => setSelectedPersonaId(persona.id)}
              className={`inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                selectedPersonaId === persona.id
                  ? 'bg-[var(--brand)] text-white'
                  : 'bg-[var(--bg-raised)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {persona.avatar && <span className="mr-1.5">{persona.avatar}</span>}
              {persona.name}
            </button>
          ))}
        </div>
      )}

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
      {/* Only append the trailing ellipsis when the label does not already end
          in one — step_start texts ship with their own ("Thinking through your
          request…"), which produced "request……". */}
      <span className={done ? '' : 'text-[var(--text-primary)]'}>{text}{!done && !/[.…]$/.test(text) && '…'}</span>
    </div>
  );
}
