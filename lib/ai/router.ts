// AI routing ladder — drop-in replacement for OpenCode's public text API.
// Failover order for every text/chat generation:
//   1. OpenCode Go (deepseek-v4-pro — fast + accurate, the app's designed model)
//   2. Ask Zo  (BYOK Claude / account default — reliable but slow on Opus)
//   3. NVIDIA NIM (last resort — free tier, weaker instruction-following)
// OpenCode is first because it is both fast (~3s) AND accurate on structured
// extraction. When its account is out of credits it fails fast (401) and we
// fall straight through to Ask Zo, so restoring OpenCode credits instantly
// speeds every generation back up with no code change. Each tier is skipped
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
  if (opencode.opencodeConfigured()) {
    try {
      return await opencode.generateText(opts);
    } catch (err: any) {
      lastErr = err;
    }
  }
  if (zoAskConfigured()) {
    try {
      return await zoAskText({ system: opts.system, prompt: opts.prompt, maxOutputTokens: opts.maxOutputTokens });
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
  if (opencode.opencodeConfigured()) {
    try {
      return await opencode.generateChat(opts);
    } catch (err: any) {
      lastErr = err;
    }
  }
  if (zoAskConfigured()) {
    try {
      return await zoAskChat({ system: opts.system, messages: opts.messages, maxOutputTokens: opts.maxOutputTokens });
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