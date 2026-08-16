import { z } from 'zod';
import { supabase, getVentures, getVenture } from '@/lib/db';
import { generateContentPost } from '@/lib/ai/generation';
import { obj, S, type Capability } from './types';

export const CREATIVE_CAPABILITIES: Capability[] = [
  {
    name: 'generateAdCopy',
    domain: 'creative',
    title: 'Generate ad/post copy',
    description: 'Generate social/ad post copy (hook, body, hashtags) for a venture. Provide the platform and topic; optionally a hook and CTA.',
    gate: 'read',
    inputSchema: obj({ brandId: S.string, platform: S.string, topic: S.string, hook: S.string, cta: S.string }, ['platform', 'topic']),
    zod: z.object({ brandId: z.string().optional(), platform: z.string(), topic: z.string(), hook: z.string().optional(), cta: z.string().optional() }),
    run: async (accountId, a) => {
      const v: any = a.brandId ? await getVenture(a.brandId) : (await getVentures(accountId))[0];
      return generateContentPost({ venture: { name: v?.name || 'our brand', niche: v?.niche }, platform: a.platform, topic: a.topic, hook: a.hook, cta: a.cta });
    },
  },
];
