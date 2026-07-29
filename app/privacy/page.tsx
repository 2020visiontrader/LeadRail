export const metadata = {
  title: 'Privacy Policy — LeadRail',
  description: 'How LeadRail collects, uses, and protects your data.',
};

const UPDATED = 'July 29, 2026';
const CONTACT = 'aifranckie101@gmail.com';

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-white px-6 py-16 text-neutral-800">
      <div className="mx-auto max-w-2xl">
        <a href="/" className="text-sm font-medium text-indigo-600 hover:underline">← LeadRail</a>
        <h1 className="mt-6 text-3xl font-bold text-neutral-900">Privacy Policy</h1>
        <p className="mt-2 text-sm text-neutral-500">Last updated: {UPDATED}</p>

        <div className="mt-8 space-y-6 text-[15px] leading-relaxed">
          <p>
            LeadRail (“we”, “us”) is a marketing and CRM platform that helps you manage leads, run
            outreach, and publish social content. This policy explains what we collect, how we use it,
            and the choices you have.
          </p>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Information we collect</h2>
            <ul className="mt-3 list-disc space-y-1 pl-5">
              <li><span className="font-medium">Account data</span> — your name, email, and login credentials.</li>
              <li><span className="font-medium">CRM data</span> — contacts, leads, deals, and content you create in the app.</li>
              <li>
                <span className="font-medium">Connected platform data</span> — when you connect a service such as
                Facebook, Instagram, or an email provider, we store the access tokens and account
                identifiers (Page IDs, Instagram Business account IDs) needed to act on your behalf.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">How we use it</h2>
            <ul className="mt-3 list-disc space-y-1 pl-5">
              <li>To provide the CRM, outreach, and social-publishing features you request.</li>
              <li>To publish or schedule content to the social accounts you explicitly connect.</li>
              <li>To send email on your behalf through the providers you configure.</li>
              <li>To secure, maintain, and improve the service.</li>
            </ul>
            <p className="mt-3">
              We do not sell your personal data, and we do not use data obtained from connected
              platforms for any purpose other than the features you enable.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Data sharing</h2>
            <p className="mt-3">
              We share data only with the service providers required to deliver the product (for
              example, our hosting and database provider, and the social or email platforms you connect).
              These providers process data on our instructions.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Data retention & deletion</h2>
            <p className="mt-3">
              We keep your data while your account is active. You can disconnect any integration at any
              time from <span className="font-medium">Settings → Integrations</span>, which deletes the
              stored tokens and identifiers for that platform. For full account or data deletion, see our{' '}
              <a href="/data-deletion" className="font-medium text-indigo-600 hover:underline">Data Deletion Instructions</a>.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Your rights</h2>
            <p className="mt-3">
              You may request access to, correction of, or deletion of your personal data by emailing{' '}
              <a href={`mailto:${CONTACT}`} className="font-medium text-indigo-600 hover:underline">{CONTACT}</a>.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Contact</h2>
            <p className="mt-3">
              Questions about this policy? Email{' '}
              <a href={`mailto:${CONTACT}`} className="font-medium text-indigo-600 hover:underline">{CONTACT}</a>.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
