// Shared landing-page content and entity constants.
//
// Extracted from app/welcome/page.tsx so the overview page AND the per-topic
// sub-pages (/welcome/how-it-works, /architecture, /capabilities, /faq,
// /example-run) render from ONE source. Editing a fact here changes it
// everywhere; there is no second copy to drift.
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || 'https://app.leadrail.xyz').replace(/\/$/, '');

// Matches app/privacy/page.tsx and app/terms/page.tsx exactly (packet 11.1).
export const ENTITY = 'Excalix';
export const ENTITY_CITY = 'Toronto';
export const ENTITY_REGION = 'Ontario';
export const ENTITY_COUNTRY = 'Canada';
// The address shown on the legal pages. It was a personal Gmail, which meant a
// private inbox was published on privacy, terms and data-deletion — pages that
// legally MUST carry a contact route, so it could not simply be removed. It is
// now the product's own address, overridable per environment.
//
// Marketing CTAs no longer use it at all: they post to /api/contact, which
// records the request and replies from a verified domain. A mailto does nothing
// for a visitor without a configured mail client, and fails silently when it
// does nothing.
export const CONTACT = process.env.NEXT_PUBLIC_CONTACT_EMAIL || 'hello@leadrail.xyz';


export const FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'What is LeadRail?',
    a: 'LeadRail is a marketing and CRM platform with an AI assistant built into it. You manage leads, enrichment, pipeline, outreach sequences, ad campaigns and social publishing in one place, and you can ask the assistant to do that work in plain language instead of clicking through screens. It is operated by Excalix, based in Toronto, Ontario, Canada.',
  },
  {
    q: 'Who is LeadRail for?',
    a: 'Small marketing and sales teams, agencies, and founders who run more than one brand and want an assistant that operates the tools rather than just suggesting copy. It suits teams who want to keep a person in the loop on anything that spends budget or reaches a real person.',
  },
  {
    q: 'What can the assistant actually do?',
    a: 'It works through a registry of declared capabilities across nine domains: ventures, campaigns, leads, outreach, CRM, knowledge, creative, memory and social. In practice that means listing and enriching leads, moving deals through stages, drafting and sending outreach, creating and launching Meta ad campaigns, pulling live ad insights, drafting, scheduling and publishing social posts, replying to comments, and searching your connected Notion and Google Drive.',
  },
  {
    q: 'Does LeadRail send anything without my approval?',
    a: 'No. Every capability declares a gate class. Reads and internal changes run immediately, but anything that spends money, reaches a third party, deletes irreversibly, or switches on a standing rule stops and waits for a person to approve it. That gate is enforced on the server, so a modified browser client cannot bypass it, and it applies to machine callers using the external tool endpoint as well. The approval is recorded before the action runs, and if the proposal is edited afterwards the approval is invalidated and has to be granted again.',
  },
  {
    q: 'Does the assistant show its work?',
    a: 'Yes. Each turn renders as a live step trace: what the assistant is considering, which capability it called, and whether that call succeeded or failed, followed by the written answer streaming in. Nothing happens off-screen, and approval requests appear inline in the same trace.',
  },
  {
    q: 'Which platforms does LeadRail connect to?',
    a: 'Meta — Facebook, Instagram and Threads — for publishing, comments, ads and insights; Buffer, Postiz and GoHighLevel for scheduling and distribution; Notion and Google Drive as knowledge sources; Resend and Brevo for email; and Apollo for lead enrichment and prospect search. You connect only what you use, and anything you have not configured receives nothing.',
  },
  {
    q: 'Can LeadRail manage more than one brand?',
    a: 'Yes. One account can hold several ventures, each with its own campaigns, leads, content and connected accounts. The assistant scopes its work to the venture you name.',
  },
  {
    q: 'Does LeadRail obtain consent for the people I contact?',
    a: 'No. LeadRail is a tool you use to contact people you choose; it does not obtain, record or verify their consent, and it does not check consent before a message is sent. You are responsible for having a lawful basis for every message you send. What LeadRail does provide is a per-account suppression list, an unsubscribe link in outbound sequences, and automatic suppression of addresses that hard-bounce or generate a spam complaint.',
  },
  {
    q: 'Who operates LeadRail?',
    a: 'LeadRail is operated by Excalix, based in Toronto, Ontario, Canada. The Privacy Policy and Terms of Service set out the operating entity, the AI and infrastructure providers involved, and the terms that apply.',
  },
  {
    q: 'Where is my data stored, and which providers process it?',
    a: 'Storage locations, sub-processors and transfers are set out in the LeadRail Privacy Policy, which is the authoritative source on this and is kept current. Please read it there rather than relying on a summary.',
  },
  {
    q: 'How do I get access? Is there a free trial?',
    a: 'There is no self-serve signup and no published pricing. Access is arranged directly — request a demo and we will walk through the platform and set up an account.',
  },
];

// Structured data. Deliberately omits `offers` and `aggregateRating` on the
// SoftwareApplication: there is no published price and no review corpus, and
// fabricating either is both a Google policy violation and a false statement.
export const JSON_LD = {
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

export const CAPABILITY_DOMAINS: Array<{ name: string; blurb: string }> = [
  { name: 'Leads', blurb: 'List, filter, enrich and re-status contacts; source new prospects.' },
  { name: 'CRM', blurb: 'Deals, stages, notes and tags — moved by name, not by drag.' },
  { name: 'Outreach', blurb: 'Draft messages, enrol contacts in sequences, send email.' },
  { name: 'Campaigns', blurb: 'Create, launch, pause and sync Meta ad campaigns; pull live insights.' },
  { name: 'Social', blurb: 'Draft, schedule and publish posts; read and reply to comments.' },
  { name: 'Creative', blurb: 'Generate ad copy against a stored persona and brand voice.' },
  { name: 'Knowledge', blurb: 'Search and read your connected Notion pages and Drive files.' },
  { name: 'Memory', blurb: 'Remember, list and forget durable facts across conversations.' },
  { name: 'Ventures', blurb: 'Several brands in one account, each scoped separately.' },
];
