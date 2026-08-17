export const metadata = {
  title: 'Privacy Policy — LeadRail',
  description: 'How LeadRail collects, uses, and protects your data.',
};

const UPDATED = 'August 17, 2026';

// The operating entity behind LeadRail. Do NOT add a registration number,
// incorporation form, or street address here unless it has been verified —
// invented corporate detail in a published policy is worse than an omission.
const ENTITY = 'Excalix';
const ENTITY_LOCATION = 'Toronto, Ontario, Canada';

// TODO(counsel/ops): replace with a monitored role address (e.g. privacy@ /
// legal@ on the leadrail.xyz domain) once that mailbox exists and is verified
// to receive mail. Left as the current working address deliberately: a privacy
// contact that bounces is itself a compliance failure, so this must not be
// swapped for an aspirational address.
const CONTACT = 'aifranckie101@gmail.com';

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-white px-6 py-16 text-neutral-800">
      <div className="mx-auto max-w-2xl">
        <a href="/" className="text-sm font-medium text-indigo-600 hover:underline">← LeadRail</a>
        <h1 className="mt-6 text-3xl font-bold text-neutral-900">Privacy Policy</h1>
        <p className="mt-2 text-sm text-neutral-500">Last updated: {UPDATED}</p>

        <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">Draft pending legal review</p>
          <p className="mt-2">
            This document is a working draft prepared for review by Canadian counsel and has not
            yet been approved. Items marked <span className="font-semibold">TODO</span> below are
            open questions, not statements of fact. Please do not rely on this document as a final
            or legally reviewed policy.
          </p>
        </div>

        <div className="mt-8 space-y-6 text-[15px] leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Who we are</h2>
            <p className="mt-3">
              LeadRail is operated by <span className="font-medium">{ENTITY}</span>, based in{' '}
              {ENTITY_LOCATION}. In this policy, “we”, “us”, and “our” mean {ENTITY}. LeadRail is a
              marketing and CRM platform that helps you manage leads, run outreach, and publish
              social content. This policy explains what we collect, how we use it, who it is shared
              with, and the choices you have.
            </p>
            <p className="mt-3">
              Because we operate from Canada, our handling of personal information is governed by
              the federal <span className="font-medium">Personal Information Protection and
              Electronic Documents Act (PIPEDA)</span>.
            </p>
            <p className="mt-3 text-sm text-neutral-500">
              TODO (counsel): confirm the correct legal name and form of the operating entity, its
              registered address, and any business/registration number that should appear here.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Information we collect</h2>
            <ul className="mt-3 list-disc space-y-1 pl-5">
              <li><span className="font-medium">Account data</span> — your name, email, and login credentials.</li>
              <li><span className="font-medium">CRM data</span> — contacts, leads, companies, deals, and content you create or import into the app. This includes personal information about third parties that you choose to load.</li>
              <li>
                <span className="font-medium">Connected platform data</span> — when you connect a service such as
                Facebook, Instagram, or an email provider, we store the access tokens and account
                identifiers (Page IDs, Instagram Business account IDs) needed to act on your behalf.
              </li>
              <li><span className="font-medium">Assistant content</span> — the messages you send to the in-app assistant, and the records it reads from your workspace in order to answer.</li>
              <li><span className="font-medium">Operational data</span> — message send, delivery, open, click, and unsubscribe events for outreach you run through the platform.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">How we use it</h2>
            <ul className="mt-3 list-disc space-y-1 pl-5">
              <li>To provide the CRM, outreach, assistant, and social-publishing features you request.</li>
              <li>To publish or schedule content to the social accounts you explicitly connect.</li>
              <li>To send email on your behalf through the providers you configure.</li>
              <li>To maintain suppression lists and honour unsubscribe requests.</li>
              <li>To secure, maintain, and improve the service.</li>
            </ul>
            <p className="mt-3">
              We do not sell your personal data, and we do not use data obtained from connected
              platforms for any purpose other than the features you enable.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">AI processing and model providers</h2>
            <p className="mt-3">
              LeadRail’s assistant is powered by third-party large language model providers. When
              you use the assistant,{' '}
              <span className="font-medium">
                the content of your request and the workspace records the assistant reads in order
                to answer it — which can include contact names, email addresses, company details,
                deal and campaign data, and message text — are transmitted to one of these providers
                to generate the response.
              </span>{' '}
              This happens on essentially every assistant turn. If you do not want a record sent to
              a model provider, do not ask the assistant to work with it.
            </p>
            <p className="mt-3">
              By default, requests are routed through the following chain, falling back in order
              when a provider is unavailable:
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5">
              <li><span className="font-medium">Zo Ask</span> (<span className="font-mono text-[13px]">api.zo.computer</span>) — primary text and chat generation.</li>
              <li><span className="font-medium">OpenCode Go</span> (<span className="font-mono text-[13px]">opencode.ai</span>) — fallback text and chat generation.</li>
              <li><span className="font-medium">NVIDIA NIM</span> (<span className="font-mono text-[13px]">integrate.api.nvidia.com</span>) — last-resort text and chat generation, and text embeddings used for the assistant’s memory search.</li>
              <li><span className="font-medium">Google Gemini</span> (<span className="font-mono text-[13px]">generativelanguage.googleapis.com</span>) — image generation, when you request it.</li>
            </ul>
            <p className="mt-3">
              <span className="font-medium">Customer-configured providers.</span> LeadRail also lets
              an account configure its own model providers, including OpenAI-compatible endpoints,
              Anthropic, and custom endpoints you supply. Where you do this, your requests are sent
              to the provider you chose instead of, or ahead of, the default chain above. Those
              providers are engaged by you and are your own processors: {ENTITY} does not control
              them, does not have a data processing agreement with them on your behalf, and cannot
              make any representation about how they handle your data. The list above therefore
              describes our defaults, not an exhaustive list of every provider that may receive data
              from your account.
            </p>
            <p className="mt-3 text-sm text-neutral-500">
              TODO (counsel/ops): confirm the data-retention and training terms of each default
              provider above, and whether any of them require a separate data processing agreement
              or sub-processor notice to customers.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Service providers we share data with</h2>
            <p className="mt-3">
              We share data only with the service providers required to deliver the product. These
              providers process data on our instructions, or — where you connected them yourself —
              on yours.
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5">
              <li><span className="font-medium">Database, authentication, and file storage</span> — Supabase.</li>
              <li><span className="font-medium">AI model providers</span> — Zo Ask, OpenCode Go, NVIDIA NIM, and Google Gemini, plus any provider you configure yourself (see the section above).</li>
              <li><span className="font-medium">Outbound and transactional email</span> — Resend and Brevo.</li>
              <li><span className="font-medium">Lead enrichment and prospect search</span> — Apollo.</li>
              <li><span className="font-medium">Knowledge connectors</span> — Notion and Google Drive, where you connect them.</li>
              <li><span className="font-medium">Social publishing and engagement</span> — Meta (Facebook, Instagram, Threads), Buffer, Postiz, and GoHighLevel, where you connect them.</li>
            </ul>
            <p className="mt-3">
              Which of these actually receive data depends on the integrations and providers your
              account has enabled. Connectors you have not configured receive nothing.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Where your data is stored</h2>
            <p className="mt-3">
              Your account and CRM data are stored in a Supabase-hosted PostgreSQL database and in
              Supabase file storage.{' '}
              <span className="font-medium">
                That database is hosted in the European Union (Supabase region eu-north-1,
                Stockholm, Sweden).
              </span>{' '}
              {ENTITY} operates from {ENTITY_LOCATION}, so personal information you provide is
              transferred to and stored outside Canada, and personnel in Canada access it from
              there.
            </p>
            <p className="mt-3">
              The AI, email, enrichment, and social providers listed above process data on their own
              infrastructure, in jurisdictions they determine. Data held or processed in any of
              these locations may be subject to the laws of that jurisdiction, including lawful
              access by foreign courts and authorities.
            </p>
            <p className="mt-3 text-sm text-neutral-500">
              TODO (counsel): the operating entity is in Canada while the primary datastore is in
              the EU. The transfer mechanism, disclosures, and contractual terms this arrangement
              requires — under PIPEDA and, if EU/UK data subjects are in scope, under the GDPR — are
              counsel’s determination. This draft states the storage location as fact and makes no
              claim about adequacy, standard contractual clauses, or transfer assessments.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Outreach, consent, and unsubscribe</h2>
            <p className="mt-3">
              LeadRail is a tool you use to contact people you choose. It does not obtain, record,
              or verify those people’s consent to be contacted, and it does not check consent before
              a message is sent.{' '}
              <span className="font-medium">
                You are responsible for having a lawful basis — including, where Canada’s
                Anti-Spam Legislation (CASL) applies, valid express or implied consent — for every
                commercial electronic message you send to every recipient you load into the
                platform, and for the accuracy of the sender identification and unsubscribe
                information in those messages.
              </span>
            </p>
            <p className="mt-3">What LeadRail does provide:</p>
            <ul className="mt-3 list-disc space-y-1 pl-5">
              <li>A per-account suppression list. Addresses and domains on it are filtered out before a send.</li>
              <li>An unsubscribe link in outbound sequences. Confirming it adds the address to your suppression list and marks the contact unsubscribed.</li>
              <li>Automatic suppression of addresses that hard-bounce or generate a spam complaint at the sending provider.</li>
            </ul>
            <p className="mt-3">
              Suppression and unsubscribe are enforced per account. They are not a substitute for
              obtaining consent in the first place.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Data retention &amp; deletion</h2>
            <p className="mt-3">
              We keep your data while your account is active. You can disconnect any integration at
              any time from <span className="font-medium">Settings → Integrations</span>, which
              deletes the stored tokens and identifiers for that platform.
            </p>
            <p className="mt-3">
              When an account owner requests account deletion, the deletion is scheduled 30 days
              out. During that grace window the account continues to work and the request can be
              cancelled. After the window elapses, a scheduled job removes the account’s stored
              files and then deletes the account record; all tenant-scoped data is removed with it
              by database cascade.
            </p>
            <p className="mt-3">
              A privacy audit record of the deletion itself — the action, the requesting user, and
              the timestamp — is deliberately retained after the purge, so that the erasure can be
              demonstrated. That record does not retain the deleted CRM content.
            </p>
            <p className="mt-3">
              For full account or data deletion, see our{' '}
              <a href="/data-deletion" className="font-medium text-indigo-600 hover:underline">Data Deletion Instructions</a>.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Your rights</h2>
            <p className="mt-3">
              Under PIPEDA you have the right to ask what personal information we hold about you, to
              be told how it has been used and to whom it has been disclosed, to challenge its
              accuracy and have it corrected, and to withdraw consent to our use of it (subject to
              legal and contractual limits). You may also complain to the Office of the Privacy
              Commissioner of Canada.
            </p>
            <p className="mt-3">
              To exercise any of these rights, email{' '}
              <a href={`mailto:${CONTACT}`} className="font-medium text-indigo-600 hover:underline">{CONTACT}</a>.
              We will respond within the timeframe PIPEDA requires. We may need to verify your
              identity before acting on a request.
            </p>
            <p className="mt-3">
              If you are an individual whose information was loaded into LeadRail by one of our
              customers, that customer — not {ENTITY} — decides what is collected and why. Please
              direct access, correction, and deletion requests to them; we will assist them in
              responding.
            </p>
            <p className="mt-3 text-sm text-neutral-500">
              TODO (counsel): decide whether this policy should also claim coverage under the EU and
              UK GDPR (which apply to EU/UK data subjects regardless of where {ENTITY} is
              established) and Quebec’s Law 25 (which applies to Quebec residents). If so, the
              corresponding legal bases, transfer mechanism, and — for Law 25 — a designated privacy
              officer need to be stated. This draft deliberately makes no such claim.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Changes to this policy</h2>
            <p className="mt-3">
              We may update this policy from time to time. When we do, we will revise the “last
              updated” date above.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Contact</h2>
            <p className="mt-3">
              Questions about this policy? Email{' '}
              <a href={`mailto:${CONTACT}`} className="font-medium text-indigo-600 hover:underline">{CONTACT}</a>, or
              write to {ENTITY}, {ENTITY_LOCATION}.
            </p>
            <p className="mt-3 text-sm text-neutral-500">
              TODO (ops): replace the address above with a monitored role mailbox, and add the
              registered mailing address once confirmed.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
