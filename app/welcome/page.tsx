import type { Metadata } from 'next';
import ExampleRun from '@/components/welcome/ExampleRun';
import ArchitectureTabs from '@/components/welcome/ArchitectureTabs';

// ============================================================================
// PUBLIC LANDING PAGE — Packet 11.2
// ============================================================================
//
// This is a SERVER COMPONENT on purpose. All copy, headings, FAQ text and
// JSON-LD render in the initial HTML; the only client islands are the tab
// explorer and the scripted replay, and even those render their full text
// server-side. If the copy ever moves behind hydration, answer engines stop
// seeing it and the GEO work here is wasted.
//
// ---------------------------------------------------------------------------
// EVIDENCE RULES THAT GOVERN THIS FILE (do not relax without a new packet)
// ---------------------------------------------------------------------------
// Excalix has no customers to name, no measured outcome data, no certifications
// and no published pricing. Therefore this page carries NONE of the following,
// and an empty placeholder is worse than an omission:
//   - customer logos, testimonials, headshots, case studies
//   - impact metrics, uptime figures, customer counts, "X% faster"
//   - SOC 2 / ISO / HIPAA / "GDPR compliant" claims or a certification row
//   - pricing, plans, or a free tier
//   - data residency, storage location, or any compliance posture. Storage and
//     transfers are a nuanced matter settled in /privacy, which is the single
//     authoritative source. A marketing-page summary of it would be wrong.
//
// CTA HONESTY: there is no self-serve signup — /login is the only entry. Every
// CTA on this page therefore says "Book a demo" or "Request access". Never
// "Start free", "Sign up free", or anything implying instant self-service.
//
// ---------------------------------------------------------------------------
// NEGATIVE KEYWORDS — (a) paid-search exclusions, for future Google Ads
// ---------------------------------------------------------------------------
// Add as campaign-level negatives. These attract traffic the product cannot
// serve, or the wrong vertical entirely:
//   free · crack · torrent · nulled · open source · github · tutorial · course ·
//   jobs · salary · internship · template · resume · legal AI · harvey ·
//   legora · medical · pirate · download · apk
//
// ---------------------------------------------------------------------------
// NEGATIVE KEYWORDS — (b) on-page terms that must NEVER appear here
// ---------------------------------------------------------------------------
// This list has compliance weight, not just taste. Excalix operates from
// Canada, so CASL frames its own marketing, and packet 11.1 established that
// LeadRail does NOT implement consent capture or consent-of-record. Marketing a
// consent posture the product lacks would contradict the privacy policy that
// shipped alongside this page.
//
//   "cold email at scale" · "bulk email blast" · "email scraper" ·
//   "scrape leads" · "unlimited sending" · "no opt-in needed" ·
//   "fully autonomous" · "set and forget" · "hands-off outreach" ·
//   "guaranteed deliverability"
//
// They also attract spam-adjacent users who would get the platform's sending
// domains blocked. The positioning here leads on control, approval and
// auditability instead — which is both true and the stronger position.
// ============================================================================

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://app.leadrail.xyz').replace(/\/$/, '');

// Matches app/privacy/page.tsx and app/terms/page.tsx exactly (packet 11.1).
const ENTITY = 'Excalix';
const ENTITY_CITY = 'Toronto';
const ENTITY_REGION = 'Ontario';
const ENTITY_COUNTRY = 'Canada';
const CONTACT = 'aifranckie101@gmail.com';

const DEMO_MAILTO = `mailto:${CONTACT}?subject=${encodeURIComponent('LeadRail — demo request')}`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'LeadRail — the AI marketing CRM that asks before it acts',
  description:
    'LeadRail is an AI marketing and CRM platform from Excalix in Toronto. Its assistant runs your leads, campaigns and social posts, shows every step, and needs approval before it spends.',
  alternates: { canonical: '/welcome' },
  keywords: [
    'AI CRM',
    'AI marketing assistant',
    'agentic marketing platform',
    'human-in-the-loop AI marketing',
    'AI with approval workflow',
    'auditable AI agent',
    'lead generation software',
    'lead enrichment',
    'Meta ads management',
    'social media scheduling',
    'multi-brand marketing platform',
  ],
  openGraph: {
    type: 'website',
    url: `${SITE_URL}/welcome`,
    siteName: 'LeadRail',
    title: 'LeadRail — the AI marketing CRM that asks before it acts',
    description:
      'An AI assistant that runs your marketing and CRM in plain language, shows every step it takes, and stops for your approval before it spends money or contacts anyone.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'LeadRail — the AI marketing CRM that asks before it acts',
    description:
      'An AI assistant that runs your marketing and CRM in plain language, shows every step, and stops for approval before it spends money or contacts anyone.',
  },
};

// --- FAQ: one source of truth, rendered as visible copy AND as FAQPage JSON-LD.
// Every answer must be true of the shipped product today.
const FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'What is LeadRail?',
    a: 'LeadRail is a marketing and CRM platform with an AI assistant built into it. You manage leads, enrichment, pipeline, outreach sequences, ad campaigns and social publishing in one place, and you can ask the assistant to do that work in plain language instead of clicking through screens. It is operated by Excalix, based in Toronto, Ontario, Canada.',
  },
  {
    q: 'Who is LeadRail for?',
    a: 'Small marketing and sales teams, agencies, and founders who run more than one brand and want an assistant that operates the tools rather than just suggesting copy. It suits teams who want to keep a person in the loop on anything that spends budget or reaches a real person.',
  },
  {
    q: 'What can the assistant actually do?',
    a: 'It works through a registry of declared capabilities across nine domains: ventures, campaigns, leads, outreach, CRM, knowledge, creative, memory and social. In practice that means listing and enriching leads, moving deals through stages, drafting and sending outreach, creating and launching Meta ad campaigns, pulling live ad insights, drafting, scheduling and publishing social posts, replying to comments, and searching your connected Notion and Google Drive.',
  },
  {
    q: 'Does LeadRail send anything without my approval?',
    a: 'No. Every capability declares a gate class. Reads and internal changes run immediately, but anything that spends money, reaches a third party, deletes irreversibly, or switches on a standing rule stops and waits for a person to approve it. That gate is enforced on the server, so a modified browser client cannot bypass it, and it applies to machine callers using the external tool endpoint as well. The approval is recorded before the action runs, and if the proposal is edited afterwards the approval is invalidated and has to be granted again.',
  },
  {
    q: 'Does the assistant show its work?',
    a: 'Yes. Each turn renders as a live step trace: what the assistant is considering, which capability it called, and whether that call succeeded or failed, followed by the written answer streaming in. Nothing happens off-screen, and approval requests appear inline in the same trace.',
  },
  {
    q: 'Which platforms does LeadRail connect to?',
    a: 'Meta — Facebook, Instagram and Threads — for publishing, comments, ads and insights; Buffer, Postiz and GoHighLevel for scheduling and distribution; Notion and Google Drive as knowledge sources; Resend and Brevo for email; and Apollo for lead enrichment and prospect search. You connect only what you use, and anything you have not configured receives nothing.',
  },
  {
    q: 'Can LeadRail manage more than one brand?',
    a: 'Yes. One account can hold several ventures, each with its own campaigns, leads, content and connected accounts. The assistant scopes its work to the venture you name.',
  },
  {
    q: 'Does LeadRail obtain consent for the people I contact?',
    a: 'No. LeadRail is a tool you use to contact people you choose; it does not obtain, record or verify their consent, and it does not check consent before a message is sent. You are responsible for having a lawful basis for every message you send. What LeadRail does provide is a per-account suppression list, an unsubscribe link in outbound sequences, and automatic suppression of addresses that hard-bounce or generate a spam complaint.',
  },
  {
    q: 'Who operates LeadRail?',
    a: 'LeadRail is operated by Excalix, based in Toronto, Ontario, Canada. The Privacy Policy and Terms of Service set out the operating entity, the AI and infrastructure providers involved, and the terms that apply.',
  },
  {
    q: 'Where is my data stored, and which providers process it?',
    a: 'Storage locations, sub-processors and transfers are set out in the LeadRail Privacy Policy, which is the authoritative source on this and is kept current. Please read it there rather than relying on a summary.',
  },
  {
    q: 'How do I get access? Is there a free trial?',
    a: 'There is no self-serve signup and no published pricing. Access is arranged directly — request a demo and we will walk through the platform and set up an account.',
  },
];

// Structured data. Deliberately omits `offers` and `aggregateRating` on the
// SoftwareApplication: there is no published price and no review corpus, and
// fabricating either is both a Google policy violation and a false statement.
const JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: ENTITY,
      url: SITE_URL,
      description: `${ENTITY} builds and operates LeadRail, an AI marketing and CRM platform.`,
      address: {
        '@type': 'PostalAddress',
        addressLocality: ENTITY_CITY,
        addressRegion: ENTITY_REGION,
        addressCountry: ENTITY_COUNTRY,
      },
      contactPoint: {
        '@type': 'ContactPoint',
        contactType: 'sales',
        email: CONTACT,
        areaServed: 'CA',
        availableLanguage: 'English',
      },
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_URL}/#software`,
      name: 'LeadRail',
      applicationCategory: 'BusinessApplication',
      applicationSubCategory: 'Marketing and CRM platform',
      operatingSystem: 'Web browser',
      url: `${SITE_URL}/welcome`,
      description:
        'LeadRail is a marketing and CRM platform with a built-in AI assistant that manages leads, outreach sequences, ad campaigns and social publishing in plain language, shows every step it takes, and requires human approval before any action that spends money or reaches a third party.',
      publisher: { '@id': `${SITE_URL}/#organization` },
      featureList: [
        'Lead management and enrichment',
        'Sales pipeline and deal stages',
        'Outreach sequences with suppression and unsubscribe handling',
        'Meta ad campaign creation, launch and live insights',
        'Social publishing and comment management for Facebook, Instagram and Threads',
        'AI assistant with a visible step-by-step trace',
        'Server-enforced human approval for spending and external sends',
        'Durable assistant memory across conversations',
        'Multiple brands in a single account',
      ],
    },
    {
      '@type': 'FAQPage',
      '@id': `${SITE_URL}/welcome#faq`,
      mainEntity: FAQ.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: 'LeadRail',
      publisher: { '@id': `${SITE_URL}/#organization` },
    },
  ],
};

const CAPABILITY_DOMAINS: Array<{ name: string; blurb: string }> = [
  { name: 'Leads', blurb: 'List, filter, enrich and re-status contacts; source new prospects.' },
  { name: 'CRM', blurb: 'Deals, stages, notes and tags — moved by name, not by drag.' },
  { name: 'Outreach', blurb: 'Draft messages, enrol contacts in sequences, send email.' },
  { name: 'Campaigns', blurb: 'Create, launch, pause and sync Meta ad campaigns; pull live insights.' },
  { name: 'Social', blurb: 'Draft, schedule and publish posts; read and reply to comments.' },
  { name: 'Creative', blurb: 'Generate ad copy against a stored persona and brand voice.' },
  { name: 'Knowledge', blurb: 'Search and read your connected Notion pages and Drive files.' },
  { name: 'Memory', blurb: 'Remember, list and forget durable facts across conversations.' },
  { name: 'Ventures', blurb: 'Several brands in one account, each scoped separately.' },
];

export default function WelcomePage() {
  return (
    <div className="min-h-screen bg-[var(--bg-canvas)] text-[var(--text-primary)]">
      {/* JSON-LD is server-rendered so crawlers and answer engines see it in the
          initial HTML. The payload is static, author-controlled data. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD).replace(/</g, '\\u003c') }}
      />

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-[var(--bg-surface)] focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>

      <header className="border-b border-[var(--border-default)] bg-[var(--bg-surface)]">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--ink)] text-[13px] font-bold text-[var(--ink-fg)]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              ↝
            </span>
            <span className="text-[15px] font-bold tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
              LeadRail
            </span>
          </span>
          <nav aria-label="Page sections" className="hidden gap-4 text-[13px] text-[var(--text-secondary)] md:flex">
            <a href="#example-run" className="hover:text-[var(--text-primary)]">Example run</a>
            <a href="#how-it-works" className="hover:text-[var(--text-primary)]">How it works</a>
            <a href="#architecture" className="hover:text-[var(--text-primary)]">Architecture</a>
            <a href="#capabilities" className="hover:text-[var(--text-primary)]">Capabilities</a>
            <a href="#faq" className="hover:text-[var(--text-primary)]">FAQ</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <a
              href="/login"
              className="rounded-md px-3 py-1.5 text-[13px] font-medium text-[var(--text-secondary)] transition hover:bg-[var(--bg-raised)] hover:text-[var(--text-primary)]"
            >
              Sign in
            </a>
            <a
              href={DEMO_MAILTO}
              className="rounded-md bg-[var(--ink)] px-3 py-1.5 text-[13px] font-semibold text-[var(--ink-fg)] transition hover:opacity-90"
            >
              Book a demo
            </a>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        {/* ---------------------------------------------------------------- */}
        {/* Hero. The first paragraph is the GEO entity definition: what it   */}
        {/* is, who operates it, who it is for — quotable on its own.         */}
        {/* ---------------------------------------------------------------- */}
        <section className="py-14 sm:py-20">
          <p className="text-[13px] font-semibold uppercase tracking-wide text-[var(--brand)]">
            Human-in-the-loop AI marketing
          </p>
          <h1 className="mt-3 max-w-3xl text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl md:text-5xl">
            An AI that runs your marketing — and asks before it spends
          </h1>
          <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-[var(--text-secondary)]">
            LeadRail is an AI marketing and CRM platform, built and operated by {ENTITY} in {ENTITY_CITY},{' '}
            {ENTITY_REGION}, {ENTITY_COUNTRY}, for small marketing teams, agencies and founders who run more than
            one brand. You describe the outcome in plain language; the assistant works through your leads,
            sequences, ad campaigns and social accounts, shows every step it takes, and stops for your approval
            before anything spends money or reaches a real person.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <a
              href={DEMO_MAILTO}
              className="rounded-lg bg-[var(--ink)] px-5 py-2.5 text-sm font-semibold text-[var(--ink-fg)] transition hover:opacity-90"
            >
              Book a demo
            </a>
            <a
              href="#example-run"
              className="rounded-lg border border-[var(--border-strong)] px-5 py-2.5 text-sm font-semibold text-[var(--text-primary)] transition hover:bg-[var(--bg-raised)]"
            >
              See an example run
            </a>
          </div>
          <p className="mt-4 text-[13px] text-[var(--text-muted)]">
            Access is arranged directly — there is no self-serve signup. Already have an account?{' '}
            <a href="/login" className="font-medium text-[var(--brand)] hover:underline">Sign in</a>.
          </p>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* The interactive centrepiece: a scripted replay, clearly labelled. */}
        {/* ---------------------------------------------------------------- */}
        <section id="example-run" aria-labelledby="example-run-h" className="scroll-mt-16 pb-14 sm:pb-20">
          <h2 id="example-run-h" className="text-2xl font-bold tracking-tight sm:text-3xl">
            Watch it work, step by step
          </h2>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-[var(--text-secondary)]">
            This is a replay of the assistant&rsquo;s real step trace: what it is considering, which action it
            called, and the approval card that interrupts anything that spends money. It is a fixed script for
            illustration — it is not connected to a model, it takes no input, and it does nothing to any account.
          </p>
          <div className="mt-6">
            <ExampleRun />
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* How it works — three self-contained factual statements.           */}
        {/* ---------------------------------------------------------------- */}
        <section id="how-it-works" aria-labelledby="how-it-works-h" className="scroll-mt-16 pb-14 sm:pb-20">
          <h2 id="how-it-works-h" className="text-2xl font-bold tracking-tight sm:text-3xl">
            How it works
          </h2>
          <div className="mt-8 grid gap-5 md:grid-cols-3">
            {[
              {
                n: '01',
                h: 'Ask in plain language',
                p: 'Tell the assistant the outcome you want — enrich these leads, compare last week’s ad creatives, draft the follow-up sequence. It plans a step, calls a LeadRail capability, reads the result, and continues until the task is done.',
              },
              {
                n: '02',
                h: 'See every step it takes',
                p: 'Each step appears as it happens, in plain language, with a live indicator that resolves to a check or a cross. There is no hidden work: if the assistant read your campaign list, you saw it read your campaign list.',
              },
              {
                n: '03',
                h: 'Approve before anything leaves',
                p: 'Anything that spends budget, reaches a third party, deletes irreversibly, or switches on a standing rule stops and waits. You see the exact action and arguments, then approve or cancel. The gate is enforced on the server.',
              },
            ].map((s) => (
              <div
                key={s.n}
                className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-6 shadow-[var(--shadow-card)]"
              >
                <span className="text-[13px] font-bold tracking-wide text-[var(--brand)]">{s.n}</span>
                <h3 className="mt-2 text-lg font-semibold">{s.h}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-[var(--text-secondary)]">{s.p}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Approval gate — the strongest honest claim on the page.           */}
        {/* ---------------------------------------------------------------- */}
        <section aria-labelledby="gate-h" className="pb-14 sm:pb-20">
          <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-6 shadow-[var(--shadow-card)] sm:p-8">
            <h2 id="gate-h" className="text-2xl font-bold tracking-tight sm:text-3xl">
              The approval gate, in detail
            </h2>
            <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-[var(--text-secondary)]">
              Every capability in LeadRail declares what class of action it is. That declaration — not a prompt,
              not a setting a model can talk its way past — decides whether it runs on its own.
            </p>
            <dl className="mt-7 grid gap-x-8 gap-y-5 sm:grid-cols-2">
              {[
                { t: 'Read', d: 'No mutation. Runs immediately.', gated: false },
                { t: 'Internal change', d: 'Changes only LeadRail’s own records. Runs immediately.', gated: false },
                { t: 'Spend', d: 'Consumes credits or ad budget. Approval required.', gated: true },
                { t: 'External send', d: 'Reaches a real third party. Approval required.', gated: true },
                { t: 'Destructive', d: 'Irreversible deletion. Approval required.', gated: true },
                { t: 'Standing rule', d: 'Switches on something that will act repeatedly on its own. Approval required, and the request has to state the ongoing nature and the cap.', gated: true },
              ].map((g) => (
                <div key={g.t} className="flex gap-3">
                  <span
                    aria-hidden
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${g.gated ? 'bg-[#D97706]' : 'bg-[var(--status-positive)]'}`}
                  />
                  <div>
                    <dt className="text-[15px] font-semibold text-[var(--text-primary)]">
                      {g.t}
                      <span className="ml-2 text-[12px] font-medium text-[var(--text-muted)]">
                        {g.gated ? 'needs approval' : 'runs immediately'}
                      </span>
                    </dt>
                    <dd className="mt-0.5 text-[14px] leading-relaxed text-[var(--text-secondary)]">{g.d}</dd>
                  </div>
                </div>
              ))}
            </dl>
            <ul className="mt-7 space-y-2 border-t border-[var(--border-default)] pt-6">
              {[
                'The gate runs on the server, so a modified browser client cannot skip it.',
                'The approval is written down before the action runs, and the arguments that were approved are the arguments that execute.',
                'If the proposal changes after it was raised, the approval is invalidated and has to be granted again.',
                'External tools reaching LeadRail through its machine endpoint get the same gate, and leave the same audit record.',
              ].map((line) => (
                <li key={line} className="flex gap-2.5 text-[15px] leading-relaxed text-[var(--text-secondary)]">
                  <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand)]" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Architecture explorer (client island, all panels server-rendered) */}
        {/* ---------------------------------------------------------------- */}
        <section id="architecture" aria-labelledby="architecture-h" className="scroll-mt-16 pb-14 sm:pb-20">
          <h2 id="architecture-h" className="text-2xl font-bold tracking-tight sm:text-3xl">
            What LeadRail is made of
          </h2>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-[var(--text-secondary)]">
            Seven parts, each of which you can inspect the behaviour of from inside the product.
          </p>
          <div className="mt-6">
            <ArchitectureTabs />
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Capability domains                                                */}
        {/* ---------------------------------------------------------------- */}
        <section id="capabilities" aria-labelledby="capabilities-h" className="scroll-mt-16 pb-14 sm:pb-20">
          <h2 id="capabilities-h" className="text-2xl font-bold tracking-tight sm:text-3xl">
            Nine capability domains
          </h2>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-[var(--text-secondary)]">
            Each action the assistant can take is declared once, in one registry. The chat catalog, the machine
            tool list, the approval gate and the audit trail all read from the same declarations, so the assistant
            and an external client can never drift apart.
          </p>
          <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITY_DOMAINS.map((d) => (
              <li
                key={d.name}
                className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5 shadow-[var(--shadow-card)]"
              >
                <h3 className="text-[15px] font-semibold">{d.name}</h3>
                <p className="mt-1.5 text-[14px] leading-relaxed text-[var(--text-secondary)]">{d.blurb}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Multi-brand                                                       */}
        {/* ---------------------------------------------------------------- */}
        <section aria-labelledby="brands-h" className="pb-14 sm:pb-20">
          <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-6 shadow-[var(--shadow-card)] sm:p-8">
            <h2 id="brands-h" className="text-2xl font-bold tracking-tight sm:text-3xl">
              Built for more than one brand
            </h2>
            <p className="mt-3 max-w-3xl text-[15px] leading-relaxed text-[var(--text-secondary)]">
              One account holds several ventures. Each keeps its own leads, campaigns, content and connected
              accounts, and the assistant scopes its work to the venture you name — so running three brands does
              not mean running three logins, and one brand&rsquo;s data does not leak into another&rsquo;s answer.
            </p>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* FAQ — visible copy, mirrored into FAQPage JSON-LD above.          */}
        {/* ---------------------------------------------------------------- */}
        <section id="faq" aria-labelledby="faq-h" className="scroll-mt-16 pb-14 sm:pb-20">
          <h2 id="faq-h" className="text-2xl font-bold tracking-tight sm:text-3xl">
            Frequently asked questions
          </h2>
          <div className="mt-8 space-y-6">
            {FAQ.map((f) => (
              <div key={f.q} className="border-b border-[var(--border-default)] pb-6 last:border-0">
                <h3 className="text-[17px] font-semibold text-[var(--text-primary)]">{f.q}</h3>
                <p className="mt-2 max-w-3xl text-[15px] leading-relaxed text-[var(--text-secondary)]">{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Closing CTA                                                       */}
        {/* ---------------------------------------------------------------- */}
        <section aria-labelledby="cta-h" className="pb-16 sm:pb-24">
          <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-8 text-center shadow-[var(--shadow-card)]">
            <h2 id="cta-h" className="text-2xl font-bold tracking-tight sm:text-3xl">
              See it on your own campaigns
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-[15px] leading-relaxed text-[var(--text-secondary)]">
              We will walk through the platform with you, connect what you already use, and set up an account.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <a
                href={DEMO_MAILTO}
                className="rounded-lg bg-[var(--ink)] px-5 py-2.5 text-sm font-semibold text-[var(--ink-fg)] transition hover:opacity-90"
              >
                Book a demo
              </a>
              <a
                href={`mailto:${CONTACT}?subject=${encodeURIComponent('LeadRail — request access')}`}
                className="rounded-lg border border-[var(--border-strong)] px-5 py-2.5 text-sm font-semibold text-[var(--text-primary)] transition hover:bg-[var(--bg-raised)]"
              >
                Request access
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-[var(--border-default)] bg-[var(--bg-surface)]">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="text-[13px] text-[var(--text-secondary)]">
            LeadRail is operated by {ENTITY}, {ENTITY_CITY}, {ENTITY_REGION}, {ENTITY_COUNTRY}.
          </p>
          <nav aria-label="Legal and account" className="flex flex-wrap gap-x-5 gap-y-2 text-[13px]">
            <a href="/privacy" className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Privacy Policy</a>
            <a href="/terms" className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Terms of Service</a>
            <a href="/data-deletion" className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Data Deletion</a>
            <a href={`mailto:${CONTACT}`} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Contact</a>
            <a href="/login" className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Sign in</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
