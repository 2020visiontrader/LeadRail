export const metadata = {
  title: 'Data Deletion Instructions — LeadRail',
  description: 'How to request deletion of your data from LeadRail.',
};

const UPDATED = 'July 29, 2026';
// Single source of truth. These three legal pages each held their OWN copy
// of the address, so changing it in content.ts left them pointing at a
// personal Gmail — the exact drift that file claims to prevent.
import { CONTACT } from '@/components/welcome/content';

export default function DataDeletionPage() {
  return (
    <main className="min-h-screen bg-white px-6 py-16 text-neutral-800">
      <div className="mx-auto max-w-2xl">
        <a href="/" className="text-sm font-medium text-indigo-600 hover:underline">← LeadRail</a>
        <h1 className="mt-6 text-3xl font-bold text-neutral-900">Data Deletion Instructions</h1>
        <p className="mt-2 text-sm text-neutral-500">Last updated: {UPDATED}</p>

        <div className="mt-8 space-y-6 text-[15px] leading-relaxed">
          <p>
            LeadRail lets you connect social accounts (such as Facebook and Instagram) so you can
            publish and manage content from one place. If you connected an account and want us to
            delete the data associated with it, you can request deletion at any time using either
            method below.
          </p>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Delete your entire account</h2>
            <p className="mt-3">
              To erase everything, sign in and go to <span className="font-medium">Settings → Data &amp; privacy → Delete
              account</span>. Deletion is scheduled 30 days out: during that window the account keeps working and you can
              cancel; after it, every contact, venture, message, and uploaded file is permanently and irreversibly erased,
              including all stored files. The same page has <span className="font-medium">Export my data</span> to download
              everything as JSON first.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Option 1 — Delete a connection yourself in the app</h2>
            <ol className="mt-3 list-decimal space-y-1 pl-5">
              <li>Sign in to LeadRail.</li>
              <li>Go to <span className="font-medium">Settings → Integrations</span>.</li>
              <li>Find the connected platform (e.g. Facebook / Instagram) and click <span className="font-medium">Disconnect</span>.</li>
              <li>
                Disconnecting immediately revokes the stored access token and removes the connection
                record, including any Page IDs, Instagram Business account IDs, and tokens we obtained
                from that platform.
              </li>
            </ol>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Option 2 — Email a deletion request</h2>
            <p className="mt-3">
              Send an email to{' '}
              <a href={`mailto:${CONTACT}?subject=Data%20Deletion%20Request`} className="font-medium text-indigo-600 hover:underline">
                {CONTACT}
              </a>{' '}
              with the subject line <span className="font-medium">“Data Deletion Request”</span> from the
              email address on your account. Include the social account or Page you connected so we can
              locate the records. We will confirm and complete the deletion within 30 days.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">What gets deleted</h2>
            <ul className="mt-3 list-disc space-y-1 pl-5">
              <li>Access tokens and refresh tokens obtained from the connected platform.</li>
              <li>Platform identifiers we stored (Page IDs, Instagram Business account IDs, profile IDs).</li>
              <li>Any content queued or published records tied to that connection.</li>
            </ul>
            <p className="mt-3">
              Data you never shared with LeadRail is never stored, and deletion does not affect content
              that already exists on the social platform itself — that remains under your control on
              Facebook, Instagram, or the relevant platform.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-neutral-900">Contact</h2>
            <p className="mt-3">
              Questions about data deletion? Email{' '}
              <a href={`mailto:${CONTACT}`} className="font-medium text-indigo-600 hover:underline">{CONTACT}</a>.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
