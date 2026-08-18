// Landing-page sections, each renderable on its own.
//
// D12: the header nav used to be in-page anchors, so every "tab" scrolled the
// same document. Each section now also has a real route under /welcome/*, and
// both the overview page and those routes render THESE components — one source,
// no duplicated copy.
//
// Each body is fragment-wrapped because some of these (how-it-works) are more
// than one <section>; the fragment keeps that grouping intact without adding a
// wrapper element that would change the existing layout.
import ExampleRun from '@/components/welcome/ExampleRun';
import ArchitectureTabs from '@/components/welcome/ArchitectureTabs';
import { ENTITY, ENTITY_CITY, ENTITY_REGION, ENTITY_COUNTRY, CONTACT, DEMO_MAILTO, FAQ, CAPABILITY_DOMAINS } from './content';

export function HeroSection() {
  return (
    <>
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
    </>
  );
}

export function ExampleRunSection() {
  return (
    <>
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
    </>
  );
}

export function HowItWorksSection() {
  return (
    <>
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
    </>
  );
}

export function ArchitectureSection() {
  return (
    <>
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
    </>
  );
}

export function CapabilitiesSection() {
  return (
    <>
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
    </>
  );
}

export function FaqSection() {
  return (
    <>
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
    </>
  );
}
