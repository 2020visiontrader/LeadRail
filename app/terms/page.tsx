export const metadata = {
  title: 'Terms of Service — LeadRail',
  description: 'The terms that govern your use of LeadRail.',
};

const UPDATED = 'July 29, 2026';
const CONTACT = 'aifranckie101@gmail.com';

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-white px-6 py-16 text-neutral-800">
      <div className="mx-auto max-w-2xl">
        <a href="/" className="text-sm font-medium text-indigo-600 hover:underline">← LeadRail</a>
        <h1 className="mt-6 text-3xl font-bold text-neutral-900">Terms of Service</h1>
        <p className="mt-2 text-sm text-neutral-500">Last updated: {UPDATED}</p>

        <div className="mt-8 space-y-6 text-[15px] leading-relaxed">
          <p>
            These Terms govern your use of LeadRail. By creating an account or using the service, you
            agree to these Terms.
          </p>

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
            <h2 className="text-lg font-semibold text-neutral-900">Acceptable use</h2>
            <ul className="mt-3 list-disc space-y-1 pl-5">
              <li>Do not use the service to send spam or unsolicited bulk messages.</li>
              <li>Do not violate the policies of any connected platform.</li>
              <li>Do not attempt to disrupt, reverse-engineer, or gain unauthorized access to the service.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Data & privacy</h2>
            <p className="mt-3">
              Your use of the service is also governed by our{' '}
              <a href="/privacy" className="font-medium text-indigo-600 hover:underline">Privacy Policy</a>. You can
              remove connected-platform data at any time via{' '}
              <a href="/data-deletion" className="font-medium text-indigo-600 hover:underline">Data Deletion Instructions</a>.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Disclaimer & liability</h2>
            <p className="mt-3">
              The service is provided “as is” without warranties of any kind. To the maximum extent
              permitted by law, we are not liable for indirect or consequential damages arising from
              your use of the service.
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
              <a href={`mailto:${CONTACT}`} className="font-medium text-indigo-600 hover:underline">{CONTACT}</a>.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
