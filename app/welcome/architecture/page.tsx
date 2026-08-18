import type { Metadata } from 'next';
import WelcomeShell from '@/components/welcome/Shell';
import { ArchitectureSection } from '@/components/welcome/sections';
import { SITE_URL } from '@/components/welcome/content';

// D12: a real route for a section that used to be an in-page anchor. Renders
// the SAME component the overview page renders — no second copy of the copy.
// Its own title/description/canonical is the point: this is what makes the
// topic separately shareable and separately indexable.
export const metadata: Metadata = {
  title: 'Architecture — LeadRail',
  description: 'The parts LeadRail is built from — the assistant loop, the approval gate, the capability registry, model routing, memory, integrations and interfaces.',
  alternates: { canonical: `${SITE_URL}/welcome/architecture` },
  openGraph: {
    title: 'Architecture — LeadRail',
    description: 'The parts LeadRail is built from — the assistant loop, the approval gate, the capability registry, model routing, memory, integrations and interfaces.',
    url: `${SITE_URL}/welcome/architecture`,
    type: 'website',
  },
};

export default function Page() {
  return (
    <WelcomeShell active="/welcome/architecture">
      <div className="py-10 sm:py-14">
        <ArchitectureSection />
      </div>
    </WelcomeShell>
  );
}
