// Image generation ladder — mirrors router.ts's text fallback pattern.
//
// Until now, image generation was single-tier: Gemini only, and the whole
// /api/generate/image route 409'd if Gemini wasn't configured, with no
// fallback if Gemini errored mid-request. Two more tiers now exist for
// exactly the reason the text ladder grew from one tier to four: a single
// provider's outage or quota exhaustion shouldn't take the whole capability
// down.
//
//   1. Gemini (Nano Banana) — primary. Best prompt adherence, direct account.
//   2. NVIDIA NIM (black-forest-labs/flux.1-dev) — free tier fallback.
//   3. OpenRouter (google/gemini-2.5-flash-image) — paid-but-fractional-cent
//      last resort, same trade-off as deepseek-v4-flash in the text chain.
//
// Verified live (2026-08-19): NIM's flux.1-dev and OpenRouter's
// gemini-2.5-flash-image both returned real images in direct smoke tests.
// HuggingFace's hf-inference image models (FLUX.1-dev, SDXL) returned 410
// "deprecated, no longer supported by this provider" on this account — HF is
// NOT part of this ladder until a working image route is found there.

import { log } from '@/lib/logger';
import * as gemini from './gemini';
import { nimConfigured, nimGenerateImage } from './nim';
import { openrouterConfigured, openrouterGenerateImage } from './openrouter';

export interface GeneratedImage {
  mimeType: string;
  base64: string;
}

export function imageConfigured(): boolean {
  return gemini.geminiConfigured() || nimConfigured() || openrouterConfigured();
}

/** Same prompt-augmentation Gemini's own generateImage used — aspect ratio
 *  and caption are plain text instructions, not Gemini-specific API params,
 *  so they carry over unchanged to the fallback tiers. */
function buildPrompt(opts: { prompt: string; caption?: string; aspect?: string }): string {
  let prompt = opts.prompt;
  if (opts.aspect) prompt += `\n\nAspect ratio: ${opts.aspect}.`;
  if (opts.caption) {
    prompt +=
      `\n\nRender this exact caption as a clean, legible text overlay on the image` +
      ` (high-contrast, professional ad typography, no misspellings): "${opts.caption}".`;
  }
  return prompt;
}

export async function generateImage(opts: {
  prompt: string;
  caption?: string;
  aspect?: string;
  /** Anchor images the subject's identity must match. Gemini-only — see below. */
  referenceUrls?: string[];
  styleLock?: string;
}): Promise<GeneratedImage> {
  const prompt = buildPrompt(opts);
  let lastErr: any = null;

  // REFERENCE CONDITIONING IS NOT OPTIONAL WHEN ASKED FOR.
  //
  // Only the Gemini tier accepts reference images; NIM and OpenRouter below
  // take a prompt string and nothing else. Falling through to them with
  // references requested would produce a plausible image of the WRONG
  // character and report success — the exact drift the reference exists to
  // prevent, now invisible. So a conditioned request either runs on Gemini or
  // fails loudly, and never silently degrades to text-to-image.
  if (opts.referenceUrls?.length) {
    if (!gemini.geminiConfigured()) {
      throw new Error('Reference-conditioned image generation needs the Gemini tier, which is not configured.');
    }
    return gemini.generateImage(opts);
  }

  if (gemini.geminiConfigured()) {
    try {
      const img = await gemini.generateImage(opts);
      log.info('image router: tier succeeded', { tier: 'gemini' });
      return img;
    } catch (err: any) {
      log.warn('image router: tier failed', { tier: 'gemini', error: String(err?.message || err) });
      lastErr = err;
    }
  }
  if (nimConfigured()) {
    try {
      const img = await nimGenerateImage({ prompt });
      log.info('image router: tier succeeded', { tier: 'nim' });
      return img;
    } catch (err: any) {
      log.warn('image router: tier failed', { tier: 'nim', error: String(err?.message || err) });
      lastErr = err;
    }
  }
  if (openrouterConfigured()) {
    try {
      const img = await openrouterGenerateImage({ prompt });
      log.info('image router: tier succeeded', { tier: 'openrouter' });
      return img;
    } catch (err: any) {
      log.warn('image router: tier failed', { tier: 'openrouter', error: String(err?.message || err) });
      lastErr = err;
    }
  }
  throw lastErr || new Error('No image generation tier configured');
}
