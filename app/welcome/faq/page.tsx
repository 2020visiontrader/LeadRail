import type { Metadata } from 'next';
import WelcomeShell from '@/components/welcome/Shell';
import { FaqSection } from '@/components/welcome/sections';
import { SITE_URL } from '@/components/welcome/content';

// D12: a real route for a section that used to be an in-page anchor. Renders
// the SAME component the overview page renders — no second copy of the copy.
// Its own title/description/canonical is the point: this is what makes the
// topic separately shareable and separately indexable.
export const metadata: Metadata = {
  title: 'FAQ — LeadRail',
  description: 'Common questions about LeadRail — how access works, what the assistant can and cannot do, and where approval is required.',
  alternates: { canonical: `${SITE_URL}/welcome/faq` },
  openGraph: {
    title: 'FAQ — LeadRail',
    description: 'Common questions about LeadRail — how access works, what the assistant can and cannot do, and where approval is required.',
    url: `${SITE_URL}/welcome/faq`,
    type: 'website',
  },
};

export default function Page() {
  return (
    <WelcomeShell active="/welcome/faq">
      <div className="py-10 sm:py-14">
        <FaqSection />
      </div>
    </WelcomeShell>
  );
}
