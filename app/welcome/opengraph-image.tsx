import { ImageResponse } from 'next/og';

// Generated OpenGraph/Twitter card for the landing page.
//
// Built from the design system rather than shipping a broken image URL — there
// is no photographic brand asset in this repo, and a 404'd og:image is worse
// than none. `next/og` ships inside `next` itself, so this adds no dependency.
//
// It states only what the page states: the product name, the positioning line,
// and the operating entity. No metric, no logo wall, no claim.

export const alt = 'LeadRail — an AI marketing and CRM assistant that asks for approval before it spends. Operated by Excalix, Toronto, Canada.';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#0A0F1F',
          padding: '72px',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: '#2DD4BF',
              color: '#06111F',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 34,
              fontWeight: 700,
            }}
          >
            ↝
          </div>
          <div style={{ color: '#F5F7FA', fontSize: 38, fontWeight: 700 }}>LeadRail</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ color: '#F5F7FA', fontSize: 66, fontWeight: 700, lineHeight: 1.12 }}>
            An AI that runs your marketing —
          </div>
          <div style={{ color: '#2DD4BF', fontSize: 66, fontWeight: 700, lineHeight: 1.12 }}>
            and asks before it spends
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ color: '#A0AEC0', fontSize: 26 }}>
            Leads · Outreach · Ad campaigns · Social — with every step shown
          </div>
          <div style={{ color: '#6B7B93', fontSize: 22 }}>Excalix · Toronto, Canada</div>
        </div>
      </div>
    ),
    size,
  );
}
