// AI routing ladder — drop-in replacement for OpenCode's public text API.
// Failover order for every text/chat generation:
//   1. Ask Zo  (BYOK Claude — primary)
//   2. OpenCode Go (deepseek-v4-pro — second)
//   3. NVIDIA NIM (last resort)
// Each tier is skipped when unconfigured; on any error/timeout we catch and
// fall through to the next tier. If all configured tiers fail (or none are
// configured), the last error is re-thrown. Image generation stays on Gemini.

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
}): Promise<string> {
  let lastErr: any = null;
  if (zoAskConfigured()) {
    try {
      return await zoAskChat({ system: opts.system, messages: opts.messages, maxOutputTokens: opts.maxOutputTokens });
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