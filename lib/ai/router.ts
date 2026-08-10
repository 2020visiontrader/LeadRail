// AI routing ladder — drop-in replacement for OpenCode's public text API.
// Failover order for every text/chat generation:
//   1. Ask Zo  (user's Claude subscription — Haiku when set as the Zo account
//      default model; billed to the user's own Anthropic subscription)
//   2. OpenCode Go (deepseek-v4-pro — fast + accurate; used when Ask Zo fails)
//   3. NVIDIA NIM (last resort — free tier, weaker instruction-following)
// Ask Zo is first because it runs on the user's Claude subscription: with the
// Zo default model set to Haiku it is fast AND accurate on structured
// extraction. If the subscription tier errors/times out we fall through to
// OpenCode Go, then to NIM. To pin a specific model for this app regardless of
// the Zo account default, set ZOASK_MODEL to a `byok:` id. Each tier is skipped
// when unconfigured; on any error/timeout we catch and fall through. If all
// configured tiers fail (or none are configured), the last error is re-thrown.
// Image generation stays on Gemini.

import type { ChatMessage } from './opencode';
import * as opencode from './opencode';
import { zoAskConfigured, zoAskText, zoAskChat } from './zoask';
import { nimConfigured, nimText, nimChat } from './nim';

export type { ChatMessage };

export function textConfigured(): boolean {
  return zoAskConfigured() || opencode.opencodeConfigured() || nimConfigured();
}

export async function generateText(opts: {
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
}): Promise<string> {
  let lastErr: any = null;
  if (zoAskConfigured()) {
    try {
      return await zoAskText({ system: opts.system, prompt: opts.prompt, maxOutputTokens: opts.maxOutputTokens });
    } catch (err: any) {
      lastErr = err;
    }
  }
  if (opencode.opencodeConfigured()) {
    try {
      return await opencode.generateText(opts);
    } catch (err: any) {
      lastErr = err;
    }
  }
  if (nimConfigured()) {
    try {
      return await nimText(opts);
    } catch (err: any) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No AI tier configured');
}

export async function generateChat(opts: {
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
  /** Per-call Zo Ask model override (byok id). Lets latency-sensitive callers
   *  (e.g. the agent loop) pin a fast tier without changing the global default. */
  zoAskModel?: string;
}): Promise<string> {
  let lastErr: any = null;
  if (zoAskConfigured()) {
    try {
      return await zoAskChat({ system: opts.system, messages: opts.messages, maxOutputTokens: opts.maxOutputTokens, model: opts.zoAskModel });
    } catch (err: any) {
      lastErr = err;
    }
  }
  if (opencode.opencodeConfigured()) {
    try {
      return await opencode.generateChat(opts);
    } catch (err: any) {
      lastErr = err;
    }
  }
  if (nimConfigured()) {
    try {
      return await nimChat(opts);
    } catch (err: any) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No AI tier configured');
}