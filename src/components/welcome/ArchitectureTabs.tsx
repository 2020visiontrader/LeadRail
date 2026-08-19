'use client';
import { useRef, useState } from 'react';

// Tabbed architecture explorer (Packet 11.2).
//
// SEO/GEO constraint: every panel's copy is rendered into the markup on the
// server. Inactive panels are hidden with the `hidden` attribute rather than
// omitted, so all of this text is present in view-source and none of it depends
// on hydration. Clicking a tab only flips which panel is hidden — it never
// fetches or generates anything.
//
// Every statement below describes code that exists in this repository today.

interface Tab {
  id: string;
  label: string;
  heading: string;
  body: string;
  points: string[];
}

const TABS: Tab[] = [
  {
    id: 'assistant',
    label: 'Assistant',
    heading: 'Plain language in, real platform actions out',
    body:
      'You describe the outcome. The assistant plans a step, calls a LeadRail capability, reads the result, and continues until the task is done — inside the app, against your own records.',
    points: [
      'Runs as a chat panel, a docked side panel, or a command bar from anywhere in the app.',
      'Every step is shown as it happens: what it is thinking, which action it called, whether that action succeeded.',
      'A run is capped at ten steps, so it cannot wander indefinitely.',
    ],
  },
  {
    id: 'approval',
    label: 'Approval gate',
    heading: 'Nothing that spends money or reaches a person runs unasked',
    body:
      'Every capability declares a gate class. Read and internal-write actions run immediately. Actions that spend, send externally, delete irreversibly, or switch on a standing rule stop and wait for a person.',
    points: [
      'The gate is enforced on the server, not in the browser — a modified client cannot skip it.',
      'The approval is recorded before the action runs, and the recorded arguments are the arguments that execute.',
      'Editing a proposal invalidates the approval; the action has to be approved again.',
      'Machine callers get the same treatment — there is no back door for automation.',
    ],
  },
  {
    id: 'registry',
    label: 'Capability registry',
    heading: 'One declaration per platform action',
    body:
      'Each thing the assistant can do is declared once, in a single registry, across nine domains: brands, campaigns, leads, outreach, CRM, knowledge, creative, memory and social.',
    points: [
      'The chat tool catalog, the external tool list, the approval gate and the audit trail all derive from the same declarations.',
      'Capability names are stable once shipped, because external clients bind to them.',
      'Arguments are validated against a schema on both the human and the machine path.',
    ],
  },
  {
    id: 'models',
    label: 'Model routing',
    heading: 'A provider ladder, with your own providers on top',
    body:
      'Requests go through a router that falls back in order when a provider is unavailable, so a single provider outage does not take the assistant down.',
    points: [
      'An account can configure its own model providers, including OpenAI-compatible and custom endpoints.',
      'Routing and answer-writing are two separate passes: one picks the action, the other writes what you read.',
      'The answer streams as it is written, rather than appearing all at once at the end.',
    ],
  },
  {
    id: 'memory',
    label: 'Context & memory',
    heading: 'It remembers what you told it, and it reads your actual records',
    body:
      'The assistant grounds its answers in the leads, campaigns, deals and conversations in your workspace, and keeps durable facts across separate conversations.',
    points: [
      'Facts you ask it to remember persist beyond the chat they were learned in, and can be listed or forgotten.',
      'Connected knowledge sources — Notion and Google Drive — can be searched and read as part of a run.',
      'Long conversations are flagged for handoff before quality degrades, with context carried over.',
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    heading: 'The platforms the work actually happens on',
    body:
      'Connect only what you use. Anything you have not configured receives nothing.',
    points: [
      'Meta — Facebook, Instagram and Threads: publishing, comments, ads and insights.',
      'Buffer, Postiz and GoHighLevel for scheduling and distribution.',
      'Notion and Google Drive as knowledge sources.',
      'Email through Resend and Brevo; lead enrichment and prospect search through Apollo.',
    ],
  },
  {
    id: 'interfaces',
    label: 'Interfaces',
    heading: 'The same capabilities, however you reach them',
    body:
      'The in-app assistant and the external tool endpoint are two front doors onto one registry — so an external client cannot do anything the chat panel cannot, and vice versa.',
    points: [
      'An MCP endpoint exposes the capability list to external tooling.',
      'Access is per-account, with sensitive capabilities off unless explicitly opted in for that key.',
      'Permitted sensitive calls from a machine caller leave the same audit record a human-approved one does.',
    ],
  },
];

export default function ArchitectureTabs() {
  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    let next = active;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (active + 1) % TABS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (active - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    else return;
    e.preventDefault();
    setActive(next);
    refs.current[next]?.focus();
  };

  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)]">
      <div
        role="tablist"
        aria-label="How LeadRail is built"
        onKeyDown={onKeyDown}
        className="flex gap-1 overflow-x-auto border-b border-[var(--border-default)] p-2"
      >
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={i === active}
            aria-controls={`panel-${t.id}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            className={`whitespace-nowrap rounded-md px-3 py-2 text-[13px] transition ${
              i === active
                ? 'bg-[var(--brand-soft)] font-semibold text-[var(--brand)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {TABS.map((t, i) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`panel-${t.id}`}
          aria-labelledby={`tab-${t.id}`}
          hidden={i !== active}
          tabIndex={0}
          className="p-5 sm:p-6"
        >
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">{t.heading}</h3>
          <p className="mt-2 text-[15px] leading-relaxed text-[var(--text-secondary)]">{t.body}</p>
          <ul className="mt-4 space-y-2">
            {t.points.map((p) => (
              <li key={p} className="flex gap-2.5 text-[15px] leading-relaxed text-[var(--text-secondary)]">
                <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand)]" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
