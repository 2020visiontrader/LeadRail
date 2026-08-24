// LeadRail icon set — inline SVG, no dependency.
//
// WHY THESE ARE HAND-DRAWN. The console pattern we're adopting uses
// lucide-react, which is not in this package.json and which would put ~1,500
// glyphs in the bundle to use twenty. More to the point, lifting an icon set
// wholesale is how an interface ends up looking like the thing it borrowed
// from. These share the FAMILY — 16px box, 1.4 stroke, round caps and joins,
// geometric rather than illustrative — and deliberately not the glyph
// vocabulary: sliders instead of a gear, a funnel instead of a dollar sign, a
// nib instead of a pencil, a rosette instead of a gift.
//
// Rules for adding one:
//   - 16x16 viewBox, stroke="currentColor", fill="none", no hardcoded colour.
//   - strokeWidth 1.4. Thinner disappears at 13px type, thicker reads as a logo.
//   - Keep the drawing inside 2..14 so glyphs optically align in a rail.

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Dashboard — deliberately unequal panels, so it reads as a composed layout
 *  rather than the four-equal-squares grid every icon set ships. */
export const IconDashboard = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="2.5" width="5" height="6.5" rx="1.2" />
    <rect x="9.5" y="2.5" width="4" height="4" rx="1.2" />
    <rect x="2.5" y="11" width="5" height="2.5" rx="1.2" />
    <rect x="9.5" y="8.5" width="4" height="5" rx="1.2" />
  </Svg>
);

/** Assistant — a four-point spark, off-centre with a small second star. */
export const IconAssistant = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 2.5 7.8 6.2 11.5 7.5 7.8 8.8 6.5 12.5 5.2 8.8 1.5 7.5 5.2 6.2Z" />
    <path d="M12 10.5 12.6 12.4 14.5 13 12.6 13.6 12 15.5" />
  </Svg>
);

/** Leads — a person with an incoming arrow, not a plain silhouette. */
export const IconLeads = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="5.5" r="2.5" />
    <path d="M1.8 13.5c0-2.4 1.9-4 4.2-4s4.2 1.6 4.2 4" />
    <path d="M12 5.5h3M13.5 4l1.5 1.5L13.5 7" />
  </Svg>
);

/** Enrichment — stacked ascending marks: thin data becoming full. */
export const IconEnrichment = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 11.5h3" />
    <path d="M3 8h6" />
    <path d="M3 4.5h9" />
    <circle cx="12.5" cy="11.5" r="1.6" />
  </Svg>
);

/** Companies — a building with an offset annex. */
export const IconCompanies = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 13.5V4.2a1 1 0 0 1 .7-.95l4-1.2a1 1 0 0 1 1.3.95v10.5" />
    <path d="M8.5 6.5h4a1 1 0 0 1 1 1v6" />
    <path d="M1.5 13.5h13" />
    <path d="M5 6v0M5 9v0" />
  </Svg>
);

/** Deals — a funnel, the actual shape of a pipeline. */
export const IconDeals = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 3h12l-4.4 5.2v4.6l-3.2 1.7V8.2Z" />
  </Svg>
);

/** Segments — two overlapping fields, i.e. a set intersection. */
export const IconSegments = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="8" r="4.2" />
    <circle cx="10" cy="8" r="4.2" />
  </Svg>
);

/** Activities — a pulse that resolves to a flat line. */
export const IconActivities = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.5 8.5h3l1.6-4.4 2.3 8 1.7-3.6h4.4" />
  </Svg>
);

/** Inbox — a tray with an open lid slot. */
export const IconInbox = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 9.5 4 3.2A1 1 0 0 1 5 2.5h6a1 1 0 0 1 1 .7l2 6.3" />
    <path d="M2 9.5h3.2l.8 1.7h4l.8-1.7H14v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />
  </Svg>
);

/** Outreach — a paper plane, tilted, with its fold line. */
export const IconOutreach = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.2 2 1.8 7.1l4.6 1.6 1.4 4.9Z" />
    <path d="M6.4 8.7 14.2 2" />
  </Svg>
);

/** Sequences — ordered steps descending, each a beat in a cadence. */
export const IconSequences = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="3.5" cy="4" r="1.6" />
    <circle cx="8" cy="8" r="1.6" />
    <circle cx="12.5" cy="12" r="1.6" />
    <path d="M4.8 5.2 6.7 6.8M9.3 9.2l1.9 1.6" />
  </Svg>
);

/** Journeys — a path that branches, which is what a journey is. */
export const IconJourneys = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="3.5" cy="8" r="1.6" />
    <circle cx="12.5" cy="4" r="1.6" />
    <circle cx="12.5" cy="12" r="1.6" />
    <path d="M5 7.4 7.5 5.5a2 2 0 0 1 1.2-.4H11" />
    <path d="M5 8.6l2.5 1.9a2 2 0 0 0 1.2.4H11" />
  </Svg>
);

/** Templates — sheets stacked with an offset, top one ruled. */
export const IconTemplates = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="2.5" width="8.5" height="9.5" rx="1.2" />
    <path d="M7.2 5.5h4.1M7.2 8h4.1M7.2 10.2h2.4" />
    <path d="M10.5 13.5H3.7a1.2 1.2 0 0 1-1.2-1.2V5.2" />
  </Svg>
);

/** Forms — a field with a checked entry below it. */
export const IconForms = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="3" width="11" height="4" rx="1.2" />
    <path d="M2.5 10.8h4.6" />
    <path d="M9.6 10.9l1.4 1.4 2.6-3" />
  </Svg>
);

/** Content — a pen nib. Not a pencil: this is composed work, not scribbling. */
export const IconContent = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.8 4 6.6l1.6 6.2 2.4 2 2.4-2L12 6.6Z" />
    <path d="M8 1.8v10.6" />
    <path d="M4 6.6h8" />
  </Svg>
);

/** AI Pipeline — a small graph: inputs converging, one output. */
export const IconPipeline = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="3.2" cy="4" r="1.5" />
    <circle cx="3.2" cy="12" r="1.5" />
    <circle cx="8" cy="8" r="1.7" />
    <circle cx="12.8" cy="8" r="1.5" />
    <path d="M4.5 4.8 6.7 6.9M4.5 11.2l2.2-2.1M9.7 8h1.6" />
  </Svg>
);

/** Campaigns — a megaphone with two projection arcs. */
export const IconCampaigns = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 6.5v3a1 1 0 0 0 1 1h1.6L9 13.2V2.8L4.6 5.5H3a1 1 0 0 0-1 1Z" />
    <path d="M11.4 5.6a3.4 3.4 0 0 1 0 4.8" />
    <path d="M13.4 3.6a6.2 6.2 0 0 1 0 8.8" />
  </Svg>
);

/** Analytics — bars with a trend line crossing them. */
export const IconAnalytics = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2 13.5h12" />
    <path d="M4 13.5v-3M7.3 13.5V8M10.7 13.5v-4.6M14 13.5V5" />
    <path d="M3.4 7.6 7 4.2l3.4 2.6L14 2.5" />
  </Svg>
);

/** Ambassador — a rosette: recognition, not a gift box. */
export const IconAmbassador = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="6" r="3.8" />
    <path d="M5.6 9.3 4.5 14l3.5-1.8L11.5 14l-1.1-4.7" />
  </Svg>
);

/** Settings — sliders. A gear is the single most-copied glyph in software;
 *  sliders also happen to describe what the page does more honestly. */
export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 4.5h11M2.5 11.5h11" />
    <circle cx="6" cy="4.5" r="1.8" />
    <circle cx="10.5" cy="11.5" r="1.8" />
  </Svg>
);

/** Admin — a shield with a keyhole notch. */
export const IconAdmin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 1.8 3 3.6v4.2c0 3 2.1 5.5 5 6.4 2.9-.9 5-3.4 5-6.4V3.6Z" />
    <path d="M8 6.6v2.6" />
  </Svg>
);

/** Logs — a list where each line carries a status dot. */
export const IconLogs = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="3.4" cy="4" r="1.1" />
    <circle cx="3.4" cy="8" r="1.1" />
    <circle cx="3.4" cy="12" r="1.1" />
    <path d="M6.4 4h7.2M6.4 8h7.2M6.4 12h4.6" />
  </Svg>
);

/** Personas — two figures, one foregrounded: a roster with a chosen voice. */
export const IconPersonas = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="5.4" r="2.4" />
    <path d="M2 13.2c0-2.2 1.8-3.7 4-3.7s4 1.5 4 3.7" />
    <path d="M10.6 3.4a2.4 2.4 0 0 1 0 4.6" />
    <path d="M11.6 9.8c1.5.4 2.6 1.7 2.6 3.4" />
  </Svg>
);

/** Skills — a plug-in module seating into a frame. */
export const IconSkills = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.4" />
    <path d="M6.4 4.5V2.2M9.6 4.5V2.2M6.4 13.8v-2.3M9.6 13.8v-2.3" />
    <path d="M4.5 6.4H2.2M4.5 9.6H2.2M13.8 6.4h-2.3M13.8 9.6h-2.3" />
  </Svg>
);

/** Models — a stack of layers, which is what a model ladder is. */
export const IconModels = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2 14 5.2 8 8.4 2 5.2Z" />
    <path d="M2 8.4 8 11.6l6-3.2" />
    <path d="M2 11.2 8 14.4l6-3.2" />
  </Svg>
);

/** Connections — two links engaged. */
export const IconConnections = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.6 9.4 9.4 6.6" />
    <path d="M7.6 4.4 9 3a2.9 2.9 0 0 1 4.1 4.1l-1.4 1.4" />
    <path d="M8.4 11.6 7 13a2.9 2.9 0 0 1-4.1-4.1l1.4-1.4" />
  </Svg>
);

/** Platform — a server stack with an activity indicator. */
export const IconPlatform = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.5" y="2.8" width="11" height="4.2" rx="1.2" />
    <rect x="2.5" y="9" width="11" height="4.2" rx="1.2" />
    <path d="M5 4.9v0M5 11.1v0" />
  </Svg>
);

/** Usage — a meter arc with a needle. */
export const IconUsage = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.4 11.6a6.4 6.4 0 1 1 11.2 0" />
    <path d="M8 11.6 10.8 7" />
  </Svg>
);

/** Privacy — a closed lock, slightly narrow shackle. */
export const IconPrivacy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.2" y="7" width="9.6" height="6.6" rx="1.6" />
    <path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" />
  </Svg>
);

/** Ventures — overlapping brand marks. */
export const IconVentures = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.4" y="2.4" width="6.4" height="6.4" rx="1.6" />
    <rect x="7.2" y="7.2" width="6.4" height="6.4" rx="1.6" />
  </Svg>
);
