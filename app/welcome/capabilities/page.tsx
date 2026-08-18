import type { Metadata } from 'next';
import WelcomeShell from '@/components/welcome/Shell';
import { CapabilitiesSection } from '@/components/welcome/sections';
import { SITE_URL } from '@/components/welcome/content';

// D12: a real route for a section that used to be an in-page anchor. Renders
// the SAME component the overview page renders — no second copy of the copy.
// Its own title/description/canonical is the point: this is what makes the
// topic separately shareable and separately indexable.
export const metadata: Metadata = {
  title: 'Capabilities — LeadRail',
  description: 'What LeadRail can actually do, by domain — leads, sequences, campaigns, social, pipeline and reporting.',
  alternates: { canonical: `${SITE_URL}/welcome/capabilities` },
  openGraph: {
    title: 'Capabilities — LeadRail',
    description: 'What LeadRail can actually do, by domain — leads, sequences, campaigns, social, pipeline and reporting.',
    url: `${SITE_URL}/welcome/capabilities`,
    type: 'website',
  },
};

export default function Page() {
  return (
    <WelcomeShell active="/welcome/capabilities">
      <div className="py-10 sm:py-14">
        <CapabilitiesSection />
      </div>
    </WelcomeShell>
  );
}
