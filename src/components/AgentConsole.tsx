'use client';
import { useRef, useState, useEffect } from 'react';
import Button from '@/components/Button';
import Markdown from '@/components/Markdown';
import { apiGet, apiSend } from '@/lib/api';
import VoiceInput from '@/components/composer/VoiceInput';
import Attachments, { type UploadedAttachment } from '@/components/composer/Attachments';

// Live agentic console. Streams the assistant's real reasoning from
// /api/agent/stream and renders it Claude-desktop style: one plain-language
// line per step, a minimal pulsing dot while active that resolves to a check,
// and a clean approval card for actions that spend money. No fake timers —
// every line is a real step the agent actually took.

export type Step =
  | {
      kind: 'thought'; text: string; done: boolean; synthetic?: boolean;
      /** Runs alongside its siblings, so a later event starting does NOT mean
       *  this one finished. Only its own observation closes it. */
      parallel?: boolean;
      /** Matches the `key` on the observation that closes this step. */
      key?: string;
      ok?: boolean;
      observation?: string;
    }
  | { kind: 'tool'; label: string; done: boolean; ok?: boolean; metrics?: Record<string, number>; observation?: string }
  | { kind: 'error'; text: string };

// Structured analysis of a turn's tool results — see Capability.findings in
// lib/capabilities/types.ts and the evidence/claim/finding/verdict SSE events
// in lib/agent/loop.ts. Mirrors that server-side shape exactly; the UI never
// invents a field the wire event didn't carry.
type Basis = { kind: 'direct_observation' } | { kind: 'crm_history'; n: number } | { kind: 'heuristic'; rule: string };
interface Claim { id: string; text: string; basis: Basis; evidenceIds: string[] }
interface Finding { id: string; claimId: string; severity: 'low' | 'medium' | 'high'; recommendation?: string }
interface Verdict { summary: string; findingIds: string[] }

interface Proposal { tool: string; title: string; args: Record<string, any>; summary: string; approvalId?: string }
type Turn = { role: 'user' } & { text: string; id?: string } | {
  role: 'assistant'; text: string; steps: Step[];
  evidence?: Record<string, string>; claims?: Claim[]; findings?: Finding[]; verdict?: Verdict;
};

// Map internal tool names to plain-language present-tense actions.
const TOOL_VERB: Record<string, string> = {
  listVentures: 'Checking your brands',
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
  listSocialMessages: 'Reading your direct messages',
  webSearch: 'Searching the web',
  getSocialInsights: 'Pulling that post’s performance',
  listSocialPosts: 'Reading what that account has posted',
  getSocialProfile: 'Looking at that profile',
  researchSocialProfile: 'Researching that profile',
  runContentPipeline: 'Running the content engine',
  listContentPipelineRuns: 'Looking up past content runs',
  getContentPipelineRun: 'Opening that content run',
  listAutomations: 'Checking your automations',
  createAutomation: 'Setting up that automation',
  enableAutomation: 'Switching that automation on',
  disableAutomation: 'Switching that automation off',
  deleteAutomation: 'Deleting that automation',
  listNotifications: 'Checking your notifications',
  markNotificationsRead: 'Clearing your notifications',
  listApprovals: 'Checking what is waiting on you',
  createVenture: 'Creating that venture',
  updateVenture: 'Updating that venture',
  listTemplates: 'Looking through your templates',
  createTemplate: 'Saving that template',
  createSequence: 'Building that follow-up sequence',
  listSkills: 'Checking which skills are on',
  setSkillEnabled: 'Switching that skill',
  generateImage: 'Generating the image',
  listContentItems: 'Looking at the content board',
  getContentBoard: 'Checking where content stands',
  getContentItem: 'Opening that piece',
  createContentItem: 'Adding that to the content board',
  updateContentItem: 'Editing that piece',
  setContentStatus: 'Moving that piece along',
  deleteContentItem: 'Removing that piece',
  generateContentPiece: 'Writing the piece',
  generateBrandImage: 'Generating the image',
  listCharacterRefs: 'Checking your character references',
  createCharacterRef: 'Saving that character reference',
  generateBrandVideo: 'Rendering the video',
  getVideoStatus: 'Checking on that render',
  startBrandIntake: 'Setting up the venture and researching it',
  runBrandResearch: 'Researching the market',
  listResearchFindings: 'Reading what we already know',
  proposeBrandCanon: 'Drafting what the brand stands for',
  getBrandCanon: 'Checking what the brand stands for',
  setBrandCanon: 'Recording what the brand stands for',
  scoreContentLinearity: 'Checking this sounds like the brand',
  listContentPillars: 'Checking your content pillars',
  createContentPillar: 'Adding that content pillar',
  deleteContentPillar: 'Removing that content pillar',
  listPlatformSpecs: 'Checking the platform rules',
  setPlatformSpec: 'Updating the platform rules',
  syncContentPerformance: 'Pulling the numbers from what went out',
  getContentPerformance: 'Looking at what actually performed',
  proposeContentLearnings: 'Working out what the results suggest',
  createFile: 'Putting that in a file for you',
  listSpecialists: 'Checking who can help',
  askSpecialist: 'Consulting a specialist',
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
  createLead: 'Adding that lead to your list',
  analyzeBrand: 'Working out a marketing strategy for that brand',
  getBrandStrategy: 'Looking up the saved strategy for that brand',
  reviewContent: 'Checking that copy against the quality gate',
  judgeVoice: 'Getting a second opinion on that copy',
  createGoal: 'Setting a goal to work toward',
  listGoals: 'Checking what you are working toward',
  logGoalProgress: 'Recording progress on that goal',
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
  declareContext: 'Noting that for good',
  recallSubject: 'Checking what I know about this',
  recallHistory: 'Looking at how this changed over time',
  listObservedPatterns: 'Reviewing what I have noticed',
  listStandingApprovals: 'Checking what you have already approved',
  revokeStandingApproval: 'Turning that permission back off',
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
  // --- added by the diagnostics domain (2026-08-23) ---
  diagnosePipeline: 'Checking the pipeline for stalled deals',
};
const verbFor = (tool: string, title: string) => TOOL_VERB[tool] || title || 'Working';

interface PersonaOption { id: string; name: string; avatar?: string | null }


/**
 * Rebuild displayable turns from a stored transcript.
 *
 * The transcript is the MODEL's message array, not a chat log, and painting it
 * verbatim leaks the protocol: assistant rows are raw JSON envelopes
 * ({"thought":…,"action":"tool","tool":"listLeads"}) and several user rows are
 * machine content — "OBSERVATION: …" carrying full lead records including email
 * addresses, plus the loop's own correction nudges. On reload that was rendered
 * to the user as if it were conversation.
 *
 * So: keep real user messages, drop machine ones, and for assistant rows parse
 * the envelope and keep ONLY the final answer. A row that will not parse is
 * dropped rather than shown — an unreadable JSON blob is worse than a gap.
 *
 * Steps are deliberately not reconstructed: they are live-run telemetry and are
 * not persisted, so a rehydrated turn shows its answer without a trace.
 */
function transcriptToTurns(transcript: Array<{ role: string; content: string }>): any[] {
  // Mirrors the nudges pushed in lib/agent/loop.ts — these are instructions to
  // the model, never anything the user typed.
  const NUDGES = ['Respond with ONLY', 'You already ran', 'You have enough', 'Stop calling tools'];
  const out: any[] = [];
  let seq = 0;
  for (const m of transcript || []) {
    const content = typeof m?.content === 'string' ? m.content : '';
    if (!content) continue;
    if (m.role === 'user') {
      if (content.startsWith('OBSERVATION:')) continue;
      if (NUDGES.some((n) => content.startsWith(n))) continue;
      out.push({ id: `rh-u-${seq++}`, role: 'user', text: content });
    } else if (m.role === 'assistant') {
      try {
        const p = JSON.parse(content);
        if (p && p.action === 'final' && p.message) {
          out.push({ id: `rh-a-${seq++}`, role: 'assistant', text: String(p.message), steps: [] });
        }
      } catch {
        // Non-JSON assistant content: a compose-pass answer that was stored as
        // plain prose. That IS displayable, unlike a half-written envelope.
        if (!content.trimStart().startsWith('{')) {
          out.push({ id: `rh-a-${seq++}`, role: 'assistant', text: content, steps: [] });
        }
      }
    }
  }
  return out;
}

export default function AgentConsole({ brandId, conversationId, onSteps, onConversationId, onFirstMessage }: { brandId?: string; conversationId?: string; onSteps?: (steps: Step[], busy: boolean, pendingApproval: boolean) => void; onConversationId?: (id: string | undefined) => void; onFirstMessage?: (text: string) => void }) {
  const [turns, setTurns] = useState<Array<any>>([]);
  const [input, setInput] = useState('');
  // Set of in-flight run ids. `busy` is derived from it rather than being its own
  // flag: with concurrent prompts "is something running" is a count, not a
  // boolean, and a single flag would be cleared by whichever run finished first
  // while others were still streaming.
  const [activeRuns, setActiveRuns] = useState<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  // While dictating, the level meter sits BESIDE the composer rather than
  // replacing it: the words are streaming into that box as they are spoken, so
  // hiding it would hide the thing being produced.
  const [dictating, setDictating] = useState(false);
  // Whatever was typed before dictation started. Interim passes revise the
  // spoken span, so they must replace it — without a fixed base, each refresh
  // would append to the previous one and the text would multiply.
  const dictationBase = useRef('');

  // Moving between pages inside the app does NOT stop a run: the request is not
  // tied to this component's lifetime, and the server saves the finished turn
  // in its own `finally` whether or not anyone is still watching.
  //
  // Closing or reloading the TAB is the one case that genuinely loses work —
  // the connection drops and the handler can be torn down before it persists.
  // So that is the only case warned about; warning on ordinary navigation would
  // be a lie that trains people to dismiss the dialog.
  useEffect(() => {
    if (!activeRuns.size) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [activeRuns.size]);
  const busy = activeRuns.size > 0;
  const endRun = (id: string) => {
    abortersRef.current.delete(id);
    inFlightTextRef.current.delete(id);
    setActiveRuns((prev) => { const n = new Set(prev); n.delete(id); return n; });
  };

  /** Stop every in-flight run and hand the last message back for editing.
   *
   *  WHY THE TEXT COMES BACK. Stopping almost always means "that came out
   *  wrong" — a dictation that garbled a name, a prompt missing a detail. The
   *  useful next action is to fix that sentence, not retype it from memory.
   *
   *  WHAT STOPPING DOES AND DOES NOT DO, said plainly in the trace rather than
   *  implied: it disconnects THIS browser. The server finishes the turn it
   *  started and saves it, because there is no way to reach in and unspend work
   *  already done. Anything already approved has already run. */
  function stopAll() {
    const lastText = [...inFlightTextRef.current.values()].pop();
    for (const [id, c] of abortersRef.current) {
      c.abort();
      patchTurn(id, (t: any) => {
        t.status = 'error';
        closeOpenSteps(t, true);
        t.steps.push({ kind: 'error', text: 'Stopped. The server may still finish this turn and save it.' });
      });
    }
    abortersRef.current.clear();
    inFlightTextRef.current.clear();
    setActiveRuns(new Set());
    if (lastText) setInput((prev) => (prev.trim() ? prev : lastText));
  }
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
    apiGet<{
      transcript: Array<{ role: string; content: string }>;
      pendingApproval?: { id: string; tool: string; title?: string; summary?: string } | null;
    }>(`/api/agent/conversations/${encodeURIComponent(conversationId)}`)
      .then((d) => {
        if (cancelled) return;
        const rows = Array.isArray(d.transcript) ? d.transcript : [];
        setTurns(transcriptToTurns(rows));
        // Re-surface a proposal that is still waiting, IN THE CHAT IT CAME FROM.
        //
        // The approval row is written before the needs_approval event is sent,
        // because execution is gated on it. So a turn that threw, was stopped,
        // or was navigated away from left a queue entry and no card — and the
        // work looked like it had silently gone somewhere else. Live work now
        // comes back where it was proposed; a SCHEDULED task has no
        // conversation, so its approvals stay queue-only, which is right —
        // nobody is watching a chat at 3am.
        if (d.pendingApproval) {
          setProposal({
            approvalId: d.pendingApproval.id,
            tool: d.pendingApproval.tool,
            title: d.pendingApproval.title,
            summary: d.pendingApproval.summary,
          } as any);
        }
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

  // Patch ONE assistant turn by id.
  //
  // This used to patch whichever assistant turn was last in the list, which is
  // correct only while exactly one run exists. With concurrent prompts two runs
  // stream at the same time and both would write into the same trailing turn —
  // the second task's steps would appear under the first task's answer and the
  // texts would interleave. Addressing the turn by id is what makes concurrency
  // safe; every event handler below now patches the turn its own run created.
  const patchTurn = (id: string, fn: (t: any) => void) =>
    setTurns((prev) => prev.map((t) => {
      if (t.id !== id || t.role !== 'assistant') return t;
      // steps/claims/findings and the evidence map are all deep-copied here for
      // the same reason: fn() mutates `copy` in place, and a shallow `{...t}`
      // would leave those pointing at the SAME array/object as the previous
      // turn state, so pushing into them would mutate state React never saw
      // change (identical reference in and out of setTurns).
      const copy = {
        ...t,
        steps: [...(t.steps || [])],
        claims: [...(t.claims || [])],
        findings: [...(t.findings || [])],
        evidence: { ...(t.evidence || {}) },
      };
      fn(copy);
      return copy;
    }));

  /** For call sites outside a run (approve/handoff errors), which have no turn
   *  of their own: patch the newest assistant turn — the one on screen. */
  const patchLatestAssistant = (fn: (t: any) => void) =>
    setTurns((prev) => {
      const idx = [...prev].reverse().findIndex((t) => t.role === 'assistant');
      if (idx === -1) return prev;
      const real = prev.length - 1 - idx;
      const next = [...prev];
      next[real] = { ...next[real], steps: [...(next[real].steps || [])] };
      fn(next[real]);
      return next;
    });

  /** Mark every unfinished step as finished. `failed` marks tool steps as
   *  having failed rather than merely stopped, so the trace does not show a
   *  green tick on a call that never returned. */
  function closeOpenSteps(t: any, failed = false) {
    for (const step of t.steps || []) {
      if (step.kind === 'error' || step.done) continue;
      step.done = true;
      if (failed && step.kind === 'tool') step.ok = false;
    }
  }

  const turnSeq = useRef(0);
  /** One controller per in-flight run, so Stop cancels exactly the run the user
   *  is watching and not a sibling started moments earlier. */
  const abortersRef = useRef(new Map<string, AbortController>());
  /** The text of the message being run, kept so Stop can hand it back to the
   *  composer. Stopping usually means "that came out wrong" — the useful next
   *  action is editing it, not retyping it. */
  const inFlightTextRef = useRef(new Map<string, string>());

  async function run(payload: { message?: string; approve?: any }) {
    // Id for THIS run's assistant turn. Every patch below is scoped to it, so a
    // second prompt started mid-flight cannot overwrite this one's output.
    const turnId = `turn-${Date.now()}-${turnSeq.current++}`;
    const patchAssistant = (fn: (t: any) => void) => patchTurn(turnId, fn);

    const aborter = new AbortController();
    abortersRef.current.set(turnId, aborter);
    if (payload.message) inFlightTextRef.current.set(turnId, payload.message);
    setActiveRuns((prev) => new Set(prev).add(turnId));
    setProposal(null);
    // Queue behind the first run until the thread has an id (see the note on
    // awaitConversationId). No-op for every run after the first.
    const mustWait = !conversationIdRef.current && activeRuns.size > 0;
    if (payload.message) setTurns((p) => [...p, { id: `${turnId}-u`, role: 'user', text: payload.message }]);
    setTurns((p) => [...p, { id: turnId, role: 'assistant', text: '', steps: [] }]);

    // Consumed here, cleared once the request is actually on the wire (below) —
    // so `from` reaches the server at most once. A connection failure leaves it
    // set, because nothing was sent.
    const from = pendingFromRef.current;

    // Hold here — not in send() — so the user's message is already on screen as a
    // queued turn while it waits. Blocking in send() would have made the prompt
    // vanish until the first run finished.
    if (mustWait) {
      patchAssistant((t) => t.steps.push({ kind: 'thought', text: 'Queued — starting once the first task has a thread…', done: false, synthetic: true }));
      await awaitConversationId();
    }

    let res: Response;
    try {
      res = await fetch('/api/agent/stream', {
        method: 'POST',
        signal: aborter.signal,
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
    } catch (e: any) {
      // A deliberate stop is not a fault, and stopAll has already written the
      // trace line. Saying "connection failed" here would blame the network for
      // something the user chose.
      if (e?.name !== 'AbortError') {
        patchAssistant((t) => { closeOpenSteps(t, true); t.steps.push({ kind: 'error', text: 'Connection failed. Try again.' }); });
      }
      endRun(turnId); return;
    }
    if (res.status === 401) { window.location.href = '/login'; return; }
    if (!res.body) { patchAssistant((t) => t.steps.push({ kind: 'error', text: 'No response stream.' })); endRun(turnId); return; }

    const reader = res.body.getReader();
    try {
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
        handleEvent(e, turnId);
      }
      }
    } catch (e: any) {
      // Same rule: an abort mid-stream is the user stopping, not a fault.
      if (e?.name !== 'AbortError') {
        patchAssistant((t) => { closeOpenSteps(t, true); t.steps.push({ kind: 'error', text: 'The connection dropped mid-answer.' }); });
      }
    }
    endRun(turnId);
  }

  // Takes the owning run's turnId: with concurrent runs there is no longer a
  // single "current" turn to infer, so the caller passes the one it created.
  function handleEvent(e: any, turnId: string) {
    const patchAssistant = (fn: (t: any) => void) => patchTurn(turnId, fn);
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
      if (typeof e.conversationId === 'string' && e.conversationId) {
        conversationIdRef.current = e.conversationId;
        // Lift the id to the parent. It used to live ONLY in this ref, so the
        // owning page never learned which conversation was in play and could not
        // put it in the URL or restore it — which is why a reload looked like the
        // chat had been wiped even though the transcript was safe on the server.
        onConversationId?.(e.conversationId);
      }
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
      const steps = t.steps as any[];
      const last = steps.length ? steps[steps.length - 1] : undefined;
      const pendingPlaceholder = last && last.kind === 'thought' && last.synthetic && !last.done ? last : undefined;

      // 'step_start' (from main) is the live "working" line emitted BEFORE the
      // blocking model call, so the trace shows motion during the 3-8s generation
      // window instead of appearing all at once at the end. It used to render as
      // its own permanent "Working through the next step…" entry that the real
      // 'thought'/'tool' event landed right after, so every step showed a
      // meaningless duplicate line. It now gets replaced in place instead.
      if (pendingPlaceholder && e.type === 'thought') {
        pendingPlaceholder.text = e.text;
        delete pendingPlaceholder.synthetic;
        return;
      }
      if (pendingPlaceholder && e.type === 'tool') {
        steps.pop();
      }

      // Resolve the previous pending step.
      //
      // NOT the parallel ones. This rule — "a new event means the last step
      // finished" — is correct for a sequential trace and false for a fan-out,
      // where three delegates start at once. It was putting a tick against the
      // first two the instant the third announced itself, so the trace claimed
      // two delegates had completed when none had. A step flagged `parallel`
      // stays open until its own observation arrives.
      const prevPending = [...steps].reverse().find(
        (s: Step) => 'done' in s && !s.done && !('parallel' in s && s.parallel),
      ) as Step | undefined;
      if (prevPending && 'done' in prevPending) prevPending.done = true;

      if (e.type === 'step_start') {
        steps.push({ kind: 'thought', text: e.text, done: false, synthetic: true, ...(e.parallel ? { parallel: true, key: e.key } : {}) });
      }
      else if (e.type === 'thought') steps.push({ kind: 'thought', text: e.text, done: false });
      else if (e.type === 'tool') steps.push({ kind: 'tool', label: verbFor(e.tool, e.title), done: false });
      else if (e.type === 'observation') {
        // A keyed observation closes the step that carried the same key. Fan-out
        // delegates run concurrently, so "the most recent open step" cannot say
        // which one finished — and picking wrong ticks the wrong delegate.
        if (e.key) {
          const own = t.steps.find((s: Step) => 'key' in s && s.key === e.key);
          if (own && own.kind === 'thought') {
            own.done = true;
            own.ok = e.ok;
            const text = typeof e.text === 'string' ? e.text.trim() : '';
            if (text) own.observation = text.length > 240 ? `${text.slice(0, 237)}…` : text;
          }
          return;
        }
        const last = [...t.steps].reverse().find((s: Step) => s.kind === 'tool');
        if (last && last.kind === 'tool') {
          last.done = true;
          last.ok = e.ok;
          if (e.metrics && Object.keys(e.metrics).length) last.metrics = e.metrics;
          const text = typeof e.text === 'string' ? e.text.trim() : '';
          if (text) last.observation = text.length > 240 ? `${text.slice(0, 237)}…` : text;
        }
      }
      // Structured analysis events — additive, never resolve a pending step
      // (none of the branches above match, so the fall-through here is safe).
      // Rendered as the findings panel, not folded into the step trace: these
      // are the agent's grounded conclusions, not "what it's doing".
      else if (e.type === 'evidence') { t.evidence[e.id] = e.label; }
      else if (e.type === 'claim') { t.claims.push({ id: e.id, text: e.text, basis: e.basis, evidenceIds: e.evidenceIds || [] }); }
      else if (e.type === 'finding') { t.findings.push({ id: e.id, claimId: e.claimId, severity: e.severity, recommendation: e.recommendation }); }
      else if (e.type === 'verdict') { t.verdict = { summary: e.summary, findingIds: e.findingIds || [] }; }
      // Any step still spinning when a turn ENDS is closed out, whatever the
      // outcome. Without this an error appended a red line below a step that
      // kept pulsing — and since the trace scrolls, all the operator saw was a
      // spinner that never stopped. A turn that failed after four minutes of
      // provider retries looked identical to one still working.
      else if (e.type === 'final') { t.status = 'done'; t.text = e.message; closeOpenSteps(t); }
      else if (e.type === 'needs_approval') { t.status = 'approval'; setProposal(e.proposal); closeOpenSteps(t); }
      else if (e.type === 'error') {
        t.status = 'error';
        closeOpenSteps(t, true);
        t.steps.push({ kind: 'error', text: e.message });
      }
    });
  }

  // The composer NO LONGER blocks while a run is in flight — that is the whole
  // point: start "find grants in this area", then type "analyse my script for the
  // right festival" while the first is still thinking, and both stream side by
  // side in one thread.
  //
  // ONE guard remains, and it is a real race rather than caution. Until the first
  // turn completes there is no conversationId yet; two runs fired before it
  // exists would each be treated as a NEW conversation by the server, silently
  // splitting one thread into two. So the very first prompt is serialised, and
  // everything after it is free. `canSend` drives the disabled state so the UI
  // explains itself instead of appearing broken.
  // A second prompt sent before the FIRST run has produced a conversationId is
  // queued, not refused. Blocking it (the first version of this) defeated the
  // whole feature: on a brand-new chat there is no id until the first run ends,
  // so the two-prompts-in-a-row case — the exact thing this exists for — was the
  // one case that still made you wait.
  //
  // The queue exists because of a real server constraint: a run with no
  // conversationId is treated as a NEW conversation, so firing two would split
  // one thread into two. Waiting for the id preserves the thread while keeping
  // the composer live.
  const canSend = input.trim().length > 0;
  const send = () => {
    const m = input.trim();
    if (!m) return;
    setInput('');
    onFirstMessage?.(m);
    run({ message: m });
  };

  /** Resolves once this conversation has a server-assigned id, so queued runs
   *  join the existing thread instead of forking a new one. Polls a ref rather
   *  than subscribing to state because the id is set inside a stream handler. */
  function awaitConversationId(): Promise<void> {
    if (conversationIdRef.current) return Promise.resolve();
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = setInterval(() => {
        // Give up after 60s and proceed anyway: a forked thread is a far better
        // outcome than a prompt that silently never runs.
        if (conversationIdRef.current || Date.now() - started > 60_000) {
          clearInterval(tick);
          resolve();
        }
      }, 150);
    });
  }
  // approvalId is required by the server gate (Packet 0.1). If the proposal
  // arrived without one, persistence failed upstream — refuse locally rather
  // than firing a request the server will reject.
  const approve = () => {
    if (!proposal) return;
    if (!proposal.approvalId) {
      // Not inside a run, so there is no turnId — attach to the most recent
      // assistant turn, which is the one showing the proposal.
      patchLatestAssistant((t) => t.steps.push({ kind: 'error', text: 'This action could not be recorded for approval, so it was not run.' }));
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
      patchLatestAssistant((t) => t.steps.push({ kind: 'error', text: 'Could not prepare the handoff. Your chat is unchanged — try again.' }));
      return;
    }
    pendingFromRef.current = fromId;
    conversationIdRef.current = undefined;
    onConversationId?.(undefined);
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
      <div className="flex-1 space-y-4 overflow-y-auto p-5" aria-live="polite">
        {turns.length === 0 && (
          <div className="mx-auto mt-10 max-w-md text-center text-sm text-[var(--text-muted)]">
            <div className="mb-2 text-base font-semibold text-[var(--text-primary)]">LeadRail Assistant</div>
            Ask it to find leads, compare your ad creatives, draft outreach, or pull something from Notion or Drive. You’ll see each step it takes.
          </div>
        )}
        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={t.id || i} className="flex justify-end">
              <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-[var(--brand)] px-4 py-2 text-sm text-white">{t.text}</div>
            </div>
          ) : (
            <div key={t.id || i} className="space-y-2">
              {t.steps.length > 0 && (
                <div className="space-y-1.5 rounded-xl bg-[var(--bg-raised)] px-4 py-3">
                  {t.steps.map((step: Step, index: number) => <StepRow key={index} step={step} />)}
                </div>
              )}
              {(t.findings?.length ?? 0) > 0 && (
                <FindingsPanel evidence={t.evidence || {}} claims={t.claims || []} findings={t.findings || []} verdict={t.verdict} />
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

      {/* The persona picker lived here and has been removed on purpose.
          Choosing between Ada, Nia and Milo asks the user to know an org chart
          they never agreed to learn — and to guess which specialist a question
          needs, which is the assistant's job. Selection now happens server-side
          (selectPersonasForRequest), and who is working shows up in the STEP
          TRACE instead: "Ada is checking the numbers…". Attribution without
          administration. */}
      <div className="border-t border-[var(--border-default)] pt-3">
        <div className="flex items-end gap-2 px-3 pb-3">
          <Attachments
            conversationId={conversationIdRef.current}
            attachments={attachments}
            onChange={setAttachments}
            disabled={busy || dictating}
          />
          <textarea
            rows={2}
            // Named so dictation can put the cursor here after dropping a
            // transcript in — see VoiceInput.
            data-composer
            value={input}
            placeholder="Ask LeadRail to do something…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            className="flex-1 resize-none rounded-lg border border-[var(--border-default)] bg-[var(--bg-canvas)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--brand)] focus:outline-none"
          />
          <VoiceInput
            disabled={busy}
            // Layout only. Snapshotting state here was the duplication bug:
            // this fires on every render, so the "prefix" kept absorbing the
            // text dictation had just written.
            onActiveChange={setDictating}
            // Fires once, when recording actually starts. THIS is where the
            // typed prefix is frozen.
            onStart={() => { dictationBase.current = input; }}
            // Product and venture names are exactly the words a recogniser
            // gets wrong, and exactly the ones that must be right.
            vocabulary="LeadRail, venture, campaign, pipeline, outreach, cadence"
            // REPLACES the spoken span each pass rather than appending: a later
            // pass hears more context and legitimately revises earlier words, so
            // appending would stack five versions of the same sentence.
            onInterim={(text) => {
              const base = dictationBase.current;
              setInput(text ? (base ? `${base.trim()} ${text}` : text) : base);
            }}
            // The final transcript lands in the box and is NOT sent. A
            // brain-dump is exactly what you want to read back before it goes
            // anywhere, and recognisers still mangle proper nouns.
            onFinal={(text) => {
              const base = dictationBase.current;
              setInput(base ? `${base.trim()} ${text}` : text);
            }}
          />
          {busy && (
            <Button variant="secondary" onClick={stopAll} title="Stop the running request">
              Stop
            </Button>
          )}
          <Button loading={false} disabled={!canSend} onClick={send}>
            {activeRuns.size > 1 ? `Send (${activeRuns.size} running)` : activeRuns.size === 1 ? 'Send (1 running)' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Each step's outcome was carried ENTIRELY by a coloured glyph — a green tick,
// a red cross, or a pulsing dot — with no text anywhere. Three consequences,
// and none of them are edge cases:
//   - a screen reader announced "✕ Sourcing leads", or for a running step, the
//     step text with no indication it had not finished
//   - the difference between done and failed was a colour and a glyph most of
//     whose meaning is convention
//   - hovering told you nothing
// The glyph is now decorative, with the state said in words for assistive tech
// and put in the title for everyone else.
function StepRow({ step }: { step: Step }) {
  if (step.kind === 'error') {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--status-negative)]">
        <span aria-hidden>✕</span><span className="sr-only">Error: </span>{step.text}
      </div>
    );
  }
  const text = step.kind === 'thought' ? step.text : step.label;
  const done = step.done;
  const failed = step.kind === 'tool' && step.ok === false;
  const state = failed ? 'Failed' : done ? 'Done' : 'Running';
  return (
    <div className="flex items-start gap-2.5 text-sm text-[var(--text-secondary)]" title={`${state}: ${text}`}>
      <span className="sr-only">{state}: </span>
      {failed ? (
        <span aria-hidden className="mt-0.5 text-[var(--status-negative)]">✕</span>
      ) : done ? (
        <span aria-hidden className="mt-0.5 text-[var(--status-positive)]">✓</span>
      ) : (
        <span aria-hidden className="relative mt-1 flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--brand)] opacity-70" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--brand)]" />
        </span>
      )}
      <div className="min-w-0">
        <span className={done ? '' : 'text-[var(--text-primary)]'}>{text}{!done && !/[.…]$/.test(text) && '…'}</span>
        {step.kind === 'tool' && step.observation && (
          <div className="mt-1 max-w-full truncate pl-2 text-xs text-[var(--text-muted)]" title={step.observation}>
            {step.observation}
          </div>
        )}
      </div>
    </div>
  );
}

// Plain-language basis label — "measured over N", "read directly", or the
// named rule — so a heuristic never LOOKS like a measurement. Mirrors the
// Basis union in lib/capabilities/types.ts exactly; an unrecognised shape
// (should not happen — the server is the only producer) renders nothing
// rather than guessing.
function basisLabel(basis: Basis): string {
  if (basis.kind === 'crm_history') return `measured over ${basis.n} record${basis.n === 1 ? '' : 's'}`;
  if (basis.kind === 'direct_observation') return 'read directly';
  if (basis.kind === 'heuristic') return `rule of thumb: ${basis.rule}`;
  return '';
}

const SEVERITY_COLOR: Record<Finding['severity'], string> = {
  high: 'var(--status-negative)',
  medium: '#D97706',
  low: 'var(--status-neutral)',
};

/** Structured findings, grounded in a real tool result (see diagnosePipeline /
 *  Capability.findings). Deliberately separate from the step trace above (that
 *  is "what the agent did") and the prose bubble below (that is the answer) —
 *  this is the auditable "why", one card per finding, each citing the real
 *  evidence it came from instead of asking the user to trust a claim. Claims
 *  that never cleared the bar to become a finding are transmitted (t.claims)
 *  but not rendered here — a "considered but not surfaced" section is a real
 *  follow-up, not required for the analysis to be honest today. */
function FindingsPanel({ evidence, claims, findings, verdict }: { evidence: Record<string, string>; claims: Claim[]; findings: Finding[]; verdict?: Verdict }) {
  const claimById = new Map(claims.map((c) => [c.id, c]));
  return (
    <div className="animate-fade-in space-y-2.5 rounded-xl border border-[var(--border-default)] bg-[var(--bg-raised)] px-4 py-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Findings</div>
      {verdict && <div className="text-sm font-medium text-[var(--text-primary)]">{verdict.summary}</div>}
      <div className="space-y-2">
        {findings.map((f) => {
          const claim = claimById.get(f.claimId);
          if (!claim) return null; // server always sends the claim first; a missing one is dropped, not guessed at
          const evidenceLabels = claim.evidenceIds.map((id) => evidence[id]).filter(Boolean);
          return (
            <div key={f.id} className="flex items-start gap-2.5 rounded-lg bg-[var(--bg-canvas)] px-3 py-2">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: SEVERITY_COLOR[f.severity] }} />
              <div className="min-w-0 space-y-1">
                <div className="text-sm text-[var(--text-primary)]">{claim.text}</div>
                {f.recommendation && <div className="text-sm text-[var(--text-secondary)]">{f.recommendation}</div>}
                {evidenceLabels.length > 0 && (
                  <div className="text-xs text-[var(--text-muted)]" title={evidenceLabels.join('; ')}>
                    {basisLabel(claim.basis)} — {evidenceLabels[0]}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
