import type { Metadata } from 'next';
import WelcomeShell from '@/components/welcome/Shell';
import { ExampleRunSection } from '@/components/welcome/sections';
import { SITE_URL } from '@/components/welcome/content';

// D12: a real route for a section that used to be an in-page anchor. Renders
// the SAME component the overview page renders — no second copy of the copy.
// Its own title/description/canonical is the point: this is what makes the
// topic separately shareable and separately indexable.
export const metadata: Metadata = {
  title: 'Example run — LeadRail',
  description: 'A replay of the assistant’s real step trace — what it considers, which action it calls, and the approval card that interrupts anything that spends money.',
  alternates: { canonical: `${SITE_URL}/welcome/example-run` },
  openGraph: {
    title: 'Example run — LeadRail',
    description: 'A replay of the assistant’s real step trace — what it considers, which action it calls, and the approval card that interrupts anything that spends money.',
    url: `${SITE_URL}/welcome/example-run`,
    type: 'website',
  },
};

export default function Page() {
  return (
    <WelcomeShell active="/welcome/example-run">
      <div className="py-10 sm:py-14">
        <ExampleRunSection />
      </div>
    </WelcomeShell>
  );
}
