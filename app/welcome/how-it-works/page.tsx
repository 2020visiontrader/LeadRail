import type { Metadata } from 'next';
import WelcomeShell from '@/components/welcome/Shell';
import { HowItWorksSection } from '@/components/welcome/sections';
import { SITE_URL } from '@/components/welcome/content';

// D12: a real route for a section that used to be an in-page anchor. Renders
// the SAME component the overview page renders — no second copy of the copy.
// Its own title/description/canonical is the point: this is what makes the
// topic separately shareable and separately indexable.
export const metadata: Metadata = {
  title: 'How it works — LeadRail',
  description: 'How LeadRail turns a plain-language request into planned, approved and executed marketing work across your leads, sequences, campaigns and social accounts.',
  alternates: { canonical: `${SITE_URL}/welcome/how-it-works` },
  openGraph: {
    title: 'How it works — LeadRail',
    description: 'How LeadRail turns a plain-language request into planned, approved and executed marketing work across your leads, sequences, campaigns and social accounts.',
    url: `${SITE_URL}/welcome/how-it-works`,
    type: 'website',
  },
};

export default function Page() {
  return (
    <WelcomeShell active="/welcome/how-it-works">
      <div className="py-10 sm:py-14">
        <HowItWorksSection />
      </div>
    </WelcomeShell>
  );
}
