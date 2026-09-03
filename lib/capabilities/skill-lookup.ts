// Skill lookup capability (C7 audit) — the expansion path for skillsBlock's
// per-skill truncation (lib/agent/loop.ts). skillsBlock caps what a skill's
// instructions can inject into the system prompt at 2,000 chars, appending a
// truncation marker that names this tool by slug. Without this capability that
// marker would be a promise the model can't keep — the same failure mode
// lib/capabilities/documents.ts's header comment describes for readAttachment.
//
// New file rather than an edit to an existing domain file: other agents are
// working concurrently in lib/capabilities/ (leads.ts, deals.ts, companies.ts
// are explicitly off limits this packet), and this capability doesn't belong
// to any of those domains anyway.
//
// Scoped to ENABLED skills only, via the same loadEnabledSkillsForAgent() path
// skillsBlock itself uses — so this can only ever return a skill this account
// already has switched on (and therefore already partially saw), never an
// arbitrary catalog entry, and it goes through the same security screen
// (lib/skills/security.ts) that gates what reaches the prompt in the first
// place.

import { z } from 'zod';
import { obj, S, type Capability } from './types';
import { loadEnabledSkillsForAgent } from '@/lib/skills/store';

export const SKILL_LOOKUP_CAPABILITIES: Capability[] = [
  {
    name: 'describeSkill',
    domain: 'knowledge',
    title: 'Read a skill\'s full instructions',
    description:
      'Read the FULL instructions for one of this account\'s enabled skills by its slug. Use this when a skill\'s guidance in the system prompt was cut short — it ends with a "[...truncated - call describeSkill(...) for the full text]" marker naming the slug to pass here.',
    gate: 'read',
    inputSchema: obj({ slug: S.string }, ['slug']),
    zod: z.object({ slug: z.string().min(1) }),
    // Static per-account lookup only: no write, no side effect, and — like
    // describeTools — ignores nothing account-scoped, so it can never surface
    // another account's skill.
    run: async (accountId, { slug }) => {
      const enabled = await loadEnabledSkillsForAgent(accountId);
      const match = enabled.find((s) => s.slug === slug);
      if (!match) {
        return { found: false, reason: 'No enabled skill with that slug on this account.' };
      }
      return { found: true, slug: match.slug, name: match.name, instructions: match.instructions };
    },
    digest: (_args, result) => {
      if (!result || typeof result !== 'object') return '';
      if (!result.found) return 'No enabled skill matched that slug.';
      const len = String(result.instructions || '').length;
      return `Full instructions for skill "${result.name}" (${len} chars).`;
    },
  },
];
