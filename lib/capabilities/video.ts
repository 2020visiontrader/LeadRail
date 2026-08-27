// Watching a video — the two paths, split by who owns the footage.
//
// UPLOADED VIDEO. The account has the file, so the whole pipeline is available:
// every frame is read for cuts and pace, one still per shot goes to the model
// with the transcript aligned to it. Decoding happens in the BROWSER (see
// src/lib/video-extract.ts) rather than on the server, which is not a
// convenience — a 10-minute 1080p file is ~150MB against a 25MB upload cap, so
// sending the video up was never on the table. Frames and audio go up instead,
// two orders of magnitude smaller, and the raw file never leaves the machine.
//
// A URL. Handed to Higgsfield, never fetched. Every open-source version of this
// shells out to yt-dlp; on a hosted product that is our servers pulling from
// YouTube and TikTok for paying customers, systematically, from one address.
// See ANALYSIS_TOOLS in lib/integrations/higgsfield.ts.

import { z } from 'zod';
import { obj, S, type Capability, digestLine } from './types';
import { higgsfieldUnavailableReason, analyseVideoUrl, getVideoAnalysisStatus } from '@/lib/integrations/higgsfield';
import { buildWatchReport, type TranscriptCue } from '@/lib/video/watch';
import { analyseAllFrames, type FrameThumb } from '@/lib/video/frames';

export const VIDEO_CAPABILITIES: Capability[] = [
  {
    name: 'watchVideoUrl',
    domain: 'content',
    title: 'Analyse a video by link',
    description:
      "Analyse a video that is already published somewhere — a competitor's ad, a creator's post, a YouTube clip — from its URL. Returns what the analyser found about the footage, pacing and delivery. Runs through the account's Higgsfield connection; LeadRail never downloads the video itself. Analysis takes a minute or two, so expect to check back with checkVideoAnalysis. For a video the account HAS as a file, use analyseUploadedVideo instead — it reads every frame and gives a much fuller answer.",
    gate: 'internal_write',
    inputSchema: obj({ url: S.string, question: S.string }, ['url']),
    zod: z.object({
      url: z.string().min(4),
      /** Steers the analysis. Without it the analyser answers its default
       *  question, which is rarely the one that was asked. */
      question: z.string().max(500).optional(),
    }),
    run: async (accountId, a) => {
      const blocked = await higgsfieldUnavailableReason(accountId);
      if (blocked) return { error: blocked };
      try {
        return await analyseVideoUrl(accountId, { url: a.url, question: a.question });
      } catch (e: any) {
        return { error: e?.message || 'The video analysis failed.' };
      }
    },
    // Silent on a null or empty result. A digest reaches the model AS FACT, so
    // "Analysed <url>." on a call that returned nothing is the assistant
    // telling itself something happened that did not.
    digest: (a, result) => {
      if (!result || typeof result !== 'object') return '';
      const r: any = result;
      if (r.error) return digestLine(`Video not analysed: ${r.error}`);
      if (r.jobId && r.status && r.status !== 'completed') {
        return digestLine(`Analysis of ${a.url} is ${r.status} — check back with id ${r.jobId}.`);
      }
      if (!r.raw && !r.jobId && !r.status) return '';
      return digestLine(`Analysed ${a.url}.`);
    },
  },
  {
    name: 'checkVideoAnalysis',
    domain: 'content',
    title: 'Check a video analysis',
    description:
      'Check on a video analysis that was still running when you last looked. Needs the id from the earlier attempt. An analysis that timed out is still running — this is how you pick it up rather than starting it again.',
    gate: 'read',
    inputSchema: obj({ jobId: S.string }, ['jobId']),
    zod: z.object({ jobId: z.string().min(1) }),
    run: async (accountId, a) => {
      const blocked = await higgsfieldUnavailableReason(accountId);
      if (blocked) return { error: blocked };
      try {
        return await getVideoAnalysisStatus(accountId, a.jobId);
      } catch (e: any) {
        return { error: e?.message || 'Could not read the analysis status.' };
      }
    },
  },
  {
    name: 'analyseUploadedVideo',
    domain: 'content',
    title: 'Analyse an uploaded video',
    description:
      "Read a video the account uploaded: every frame is analysed for cuts and pacing, one still per distinct shot is attached, and the transcript is lined up against them by timestamp. Returns the script, the edit rhythm, the delivery speed and the shot structure together. Use this for a video you have the file of — an ad you made, a client's footage, a recording. For a link to someone else's published video use watchVideoUrl.",
    gate: 'read',
    inputSchema: obj({ attachmentId: S.string, title: S.string, question: S.string }, ['attachmentId']),
    zod: z.object({
      attachmentId: z.string().min(1),
      title: z.string().max(200).optional(),
      question: z.string().max(500).optional(),
    }),
    // The extraction ran in the browser at upload time; this reads what it
    // stored. Deliberately NOT re-decoding server-side: that would need ffmpeg
    // in the request path and the raw file, neither of which exists here.
    run: async (accountId, a) => {
      const { loadVideoAnalysis } = await import('@/lib/video/store');
      const rec = await loadVideoAnalysis(accountId, a.attachmentId);
      if (!rec) {
        return {
          error:
            'No frame data was stored for that upload. A video has to be processed as it is uploaded — re-attach it and it will be read then.',
        };
      }
      return {
        report: buildWatchReport({
          title: a.title || rec.title,
          durationSeconds: rec.durationSeconds,
          frameTimestamps: rec.frameTimestamps,
          transcript: rec.transcript as TranscriptCue[],
          pace: rec.pace,
        }),
        frameUrls: rec.frameUrls,
      };
    },
    // Same rule — see watchVideoUrl. "Read the video" on an empty result is a
    // claim about work that did not happen.
    digest: (_a, result) => {
      if (!result || typeof result !== 'object') return '';
      const r: any = result;
      if (r.error) return digestLine(`Video not read: ${r.error}`);
      if (typeof r.report !== 'string' || !r.report) return '';
      const shots = r.report.match(/(\d+) distinct shots/)?.[1];
      return digestLine(shots ? `Read the video: ${shots} distinct shots.` : 'Read the video.');
    },
  },
];

/** Re-exported so the extraction endpoint and the capability agree on the
 *  shape without importing each other. */
export type { FrameThumb };
export { analyseAllFrames };
