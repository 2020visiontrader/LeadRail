export const metadata = {
  title: 'Terms of Service — LeadRail',
  description: 'The terms that govern your use of LeadRail.',
};

const UPDATED = 'August 17, 2026';

// The operating entity behind LeadRail. Do NOT add a registration number,
// incorporation form, or street address here unless it has been verified.
const ENTITY = 'Excalix';
const ENTITY_LOCATION = 'Toronto, Ontario, Canada';

// TODO(counsel/ops): replace with a monitored role address (e.g. legal@ on the
// leadrail.xyz domain) once that mailbox exists and is verified to receive
// mail. Left as the current working address deliberately — a notice address
// that bounces is worse than an informal one.
const CONTACT = 'aifranckie101@gmail.com';

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-white px-6 py-16 text-neutral-800">
      <div className="mx-auto max-w-2xl">
        <a href="/" className="text-sm font-medium text-indigo-600 hover:underline">← LeadRail</a>
        <h1 className="mt-6 text-3xl font-bold text-neutral-900">Terms of Service</h1>
        <p className="mt-2 text-sm text-neutral-500">Last updated: {UPDATED}</p>

        <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">Draft pending legal review</p>
          <p className="mt-2">
            This document is a working draft prepared for review by Canadian counsel and has not
            yet been approved. Items marked <span className="font-semibold">TODO</span> below are
            open questions, not statements of fact.
          </p>
        </div>

        <div className="mt-8 space-y-6 text-[15px] leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Who we are</h2>
            <p className="mt-3">
              LeadRail is operated by <span className="font-medium">{ENTITY}</span>, based in{' '}
              {ENTITY_LOCATION}. In these Terms, “we”, “us”, and “our” mean {ENTITY}. These Terms
              govern your use of LeadRail. By creating an account or using the service, you agree to
              them.
            </p>
            <p className="mt-3 text-sm text-neutral-500">
              TODO (counsel): confirm the correct legal name and form of the contracting entity and
              its registered address.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Use of the service</h2>
            <p className="mt-3">
              You may use LeadRail to manage contacts, run outreach, and publish content to social
              accounts you own or are authorized to manage. You are responsible for the content you
              create and publish, and for complying with the terms of any platform you connect
              (including Facebook, Instagram, and email providers).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Your account</h2>
            <p className="mt-3">
              You are responsible for keeping your login credentials secure and for all activity under
              your account. Notify us promptly of any unauthorized use.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Outreach and your responsibilities</h2>
            <p className="mt-3">
              LeadRail sends messages that you compose, to recipients that you supply, on your
              behalf. It does not obtain, record, or verify a recipient’s consent to be contacted,
              and it does not check consent before a message is sent.
            </p>
            <p className="mt-3">
              <span className="font-medium">
                You represent and warrant that you have a lawful basis to contact every recipient
                you load into the platform
              </span>{' '}
              — including, where Canada’s Anti-Spam Legislation (CASL) applies, valid express or
              implied consent — and that every commercial electronic message you send through the
              service identifies you accurately and contains a functioning unsubscribe mechanism.
              You are equally responsible for compliance with any other law applying to your
              recipients, and with the policies of any platform you send through.
            </p>
            <p className="mt-3">
              The service provides suppression lists and an unsubscribe flow to help you honour
              opt-outs. Using those features does not transfer responsibility for consent or for the
              lawfulness of your messages to us.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Acceptable use</h2>
            <ul className="mt-3 list-disc space-y-1 pl-5">
              <li>Do not use the service to send spam or unsolicited bulk messages.</li>
              <li>Do not send commercial electronic messages to recipients from whom you lack a lawful basis or required consent.</li>
              <li>Do not violate the policies of any connected platform.</li>
              <li>Do not attempt to disrupt, reverse-engineer, or gain unauthorized access to the service.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">AI features</h2>
            <p className="mt-3">
              The in-app assistant and generation features are powered by third-party model
              providers. Content you submit to the assistant, and the workspace records it reads in
              order to answer, are transmitted to those providers to produce a response — see the{' '}
              <a href="/privacy" className="font-medium text-indigo-600 hover:underline">Privacy Policy</a>{' '}
              for who they are. If your account configures its own model providers, requests are
              sent to the providers you chose and your agreement with them governs that processing.
            </p>
            <p className="mt-3">
              Generated output may be inaccurate, incomplete, or unsuitable for your purpose. You are
              responsible for reviewing it before you send, publish, or otherwise rely on it.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Data &amp; privacy</h2>
            <p className="mt-3">
              Your use of the service is also governed by our{' '}
              <a href="/privacy" className="font-medium text-indigo-600 hover:underline">Privacy Policy</a>. You can
              remove connected-platform data at any time via{' '}
              <a href="/data-deletion" className="font-medium text-indigo-600 hover:underline">Data Deletion Instructions</a>.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Disclaimer &amp; liability</h2>
            <p className="mt-3">
              The service is provided “as is” without warranties of any kind. To the maximum extent
              permitted by law, we are not liable for indirect or consequential damages arising from
              your use of the service.
            </p>
            <p className="mt-3 text-sm text-neutral-500">
              TODO (counsel): confirm whether a liability cap, an indemnity from the customer for
              outreach they send, and any consumer-protection carve-outs required under Ontario law
              should be added here. This draft states no cap and no indemnity.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Governing law</h2>
            <p className="mt-3">
              These Terms are governed by the laws of the Province of Ontario and the federal laws of
              Canada applicable in it, without regard to conflict-of-laws rules. You and {ENTITY}{' '}
              submit to the exclusive jurisdiction of the courts of Ontario, Canada for any dispute
              arising out of or relating to these Terms or the service.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Changes</h2>
            <p className="mt-3">
              We may update these Terms from time to time. Continued use of the service after changes
              take effect constitutes acceptance of the revised Terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Contact</h2>
            <p className="mt-3">
              Questions about these Terms? Email{' '}
              <a href={`mailto:${CONTACT}`} className="font-medium text-indigo-600 hover:underline">{CONTACT}</a>, or
              write to {ENTITY}, {ENTITY_LOCATION}.
            </p>
            <p className="mt-3 text-sm text-neutral-500">
              TODO (ops): replace the address above with a monitored role mailbox, and add the
              registered mailing address for legal notices once confirmed.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
