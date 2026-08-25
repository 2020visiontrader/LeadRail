import type { Metadata } from 'next';
import WelcomeShell from '@/components/welcome/Shell';
import {
  HeroSection, ExampleRunSection, HowItWorksSection,
  CapabilitiesSection, FaqSection,
} from '@/components/welcome/sections';
import { SITE_URL, ENTITY, ENTITY_CITY, ENTITY_REGION, ENTITY_COUNTRY, CONTACT, FAQ } from '@/components/welcome/content';

// ============================================================================
// PUBLIC LANDING PAGE — overview
// ============================================================================
//
// Still a SERVER COMPONENT, and still the full story on one page: every section
// renders here so a crawler (and a visitor who just scrolls) gets everything in
// the initial HTML. What changed in D12 is that each section ALSO has its own
// route under /welcome/*, rendering the same component from
// @/components/welcome/sections — so there is exactly one copy of the copy.
//
// The evidence rules that governed this file still apply and are unchanged:
// no customer logos, testimonials, metrics, certifications, pricing or data
// residency claims; and CTA honesty — there is no self-serve signup, so every
// CTA says "Book a demo" or "Request access", never "Start free".

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'LeadRail — the AI marketing CRM that asks before it acts',
  description:
    'LeadRail is an AI marketing and CRM platform from Excalix in Toronto. Its assistant runs your leads, campaigns and social posts, shows every step, and needs approval before it spends.',
  alternates: { canonical: '/welcome' },
  keywords: [
    'AI CRM',
    'AI marketing assistant',
    'agentic marketing platform',
    'human-in-the-loop AI marketing',
    'AI with approval workflow',
    'auditable AI agent',
    'lead generation software',
    'lead enrichment',
    'Meta ads management',
    'social media scheduling',
    'multi-brand marketing platform',
  ],
  openGraph: {
    type: 'website',
    url: `${SITE_URL}/welcome`,
    siteName: 'LeadRail',
    title: 'LeadRail — the AI marketing CRM that asks before it acts',
    description:
      'An AI assistant that runs your marketing and CRM in plain language, shows every step it takes, and stops for your approval before it spends money or contacts anyone.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'LeadRail — the AI marketing CRM that asks before it acts',
    description:
      'An AI assistant that runs your marketing and CRM in plain language, shows every step, and stops for approval before it spends money or contacts anyone.',
  },
};

const JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#organization`,
      name: ENTITY,
      url: SITE_URL,
      description: `${ENTITY} builds and operates LeadRail, an AI marketing and CRM platform.`,
      address: {
        '@type': 'PostalAddress',
        addressLocality: ENTITY_CITY,
        addressRegion: ENTITY_REGION,
        addressCountry: ENTITY_COUNTRY,
      },
      contactPoint: {
        '@type': 'ContactPoint',
        contactType: 'sales',
        email: CONTACT,
        areaServed: 'CA',
        availableLanguage: 'English',
      },
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_URL}/#software`,
      name: 'LeadRail',
      applicationCategory: 'BusinessApplication',
      applicationSubCategory: 'Marketing and CRM platform',
      operatingSystem: 'Web browser',
      url: `${SITE_URL}/welcome`,
      description:
        'LeadRail is a marketing and CRM platform with a built-in AI assistant that manages leads, outreach sequences, ad campaigns and social publishing in plain language, shows every step it takes, and requires human approval before any action that spends money or reaches a third party.',
      publisher: { '@id': `${SITE_URL}/#organization` },
      featureList: [
        'Lead management and enrichment',
        'Sales pipeline and deal stages',
        'Outreach sequences with suppression and unsubscribe handling',
        'Meta ad campaign creation, launch and live insights',
        'Social publishing and comment management for Facebook, Instagram and Threads',
        'AI assistant with a visible step-by-step trace',
        'Server-enforced human approval for spending and external sends',
        'Durable assistant memory across conversations',
        'Multiple brands in a single account',
      ],
    },
    {
      '@type': 'FAQPage',
      '@id': `${SITE_URL}/welcome#faq`,
      mainEntity: FAQ.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: 'LeadRail',
      publisher: { '@id': `${SITE_URL}/#organization` },
    },
  ],
};

export default function WelcomePage() {
  return (
    <WelcomeShell jsonLd={JSON.stringify(JSON_LD)}>
      <HeroSection />
      <ExampleRunSection />
      <HowItWorksSection />
      <CapabilitiesSection />
      <FaqSection />
    </WelcomeShell>
  );
}
