// The unified persona registry — content engine (harvested marketing/shared
// personas) plus outreach engine (authored outreach personas), composed into
// ONE array so the assistant carries both from a single import.
//
// WHY THIS FILE EXISTS. Before it, HARVESTED_PERSONA_TEMPLATES (27
// 'marketing' + 2 'shared', 0 'outreach') was read directly at all three
// resolvePersona() call sites (lib/agent/loop.ts x2, lib/capabilities/
// plans.ts). LeadRail is an outreach product with zero outreach personas
// reachable anywhere — that gap is what lib/agent/authored-personas.ts
// closes. This file is the seam: it concatenates both sources once, asserts
// slug uniqueness across the combined set (a silent collision here would
// mean one persona's voice quietly shadows another's), and exports the
// result as the templates argument every resolvePersona() call site should
// use from now on instead of HARVESTED_PERSONA_TEMPLATES directly.
//
// Per-instructions delegate-context rule (see CLAUDE.md): this file does not
// ration anything — every persona's `instructions` stays its own full,
// uncapped body. Composing the registry never truncates or shares a budget
// across personas.

import { HARVESTED_PERSONA_TEMPLATES, type HarvestedPersonaTemplate } from './harvested-personas';
import { AUTHORED_PERSONA_TEMPLATES } from './authored-personas';

/** Every persona template LeadRail knows about, from every source, as one
 *  flat array — harvested (marketing/shared) followed by authored
 *  (outreach). Order is harvested-first only because that was the original
 *  registry; resolvePersona() matches by slug, so order has no behavioral
 *  effect on lookups. */
export const PERSONA_TEMPLATES: HarvestedPersonaTemplate[] = [
  ...HARVESTED_PERSONA_TEMPLATES,
  ...AUTHORED_PERSONA_TEMPLATES,
];

// Assert slug uniqueness across the COMBINED set at module load time. A
// collision here means two templates would resolve identically and one
// would silently shadow the other for every account on that slug — exactly
// the "written but never read" / silently-wrong failure CLAUDE.md warns
// about, except worse: it would be silently WRONG, not silently absent.
// Fail loudly and immediately rather than let it surface as a support
// ticket about "the wrong persona answered."
(function assertUniqueSlugs(templates: HarvestedPersonaTemplate[]): void {
  const seen = new Map<string, string>(); // slug -> sourceRepo, for a useful error
  for (const t of templates) {
    const prior = seen.get(t.slug);
    if (prior) {
      throw new Error(
        `persona-registry: duplicate persona slug "${t.slug}" — present in both ` +
          `"${prior}" and "${t.sourceRepo}". Every persona slug must be unique across ` +
          `the combined harvested + authored registry.`,
      );
    }
    seen.set(t.slug, t.sourceRepo);
  }
})(PERSONA_TEMPLATES);
