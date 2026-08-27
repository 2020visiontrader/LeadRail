// Reading and writing a video's extracted analysis.
//
// Every read is account-scoped. An attachment id is a UUID a client supplies,
// and the row it points at belongs to somebody — filtering on account_id here
// rather than trusting the id is the difference between a lookup and an
// enumeration oracle.

import { supabase, dbReady } from '@/lib/db';
import { log } from '@/lib/logger';
import type { PaceReport } from './frames';
import type { TranscriptCue } from './watch';

export interface VideoAnalysisRecord {
  title?: string;
  durationSeconds: number;
  framesAnalysed: number;
  frameTimestamps: number[];
  frameUrls: string[];
  transcript: TranscriptCue[];
  pace?: PaceReport;
}

export async function saveVideoAnalysis(
  accountId: string,
  attachmentId: string,
  rec: VideoAnalysisRecord,
): Promise<boolean> {
  if (!dbReady()) return false;
  try {
    const { error } = await supabase.from('video_analyses').upsert([{
      account_id: accountId,
      attachment_id: attachmentId,
      title: rec.title ?? null,
      duration_seconds: rec.durationSeconds,
      frames_analysed: rec.framesAnalysed,
      frame_timestamps: rec.frameTimestamps,
      frame_urls: rec.frameUrls,
      transcript: rec.transcript,
      pace: rec.pace ?? null,
    }], { onConflict: 'attachment_id' });
    if (error) throw error;
    return true;
  } catch (e) {
    log.error('video analysis: could not store', e, { attachmentId });
    return false;
  }
}

/** Null when there is none, or it is not this account's. The caller must not be
 *  able to tell those apart. */
export async function loadVideoAnalysis(
  accountId: string,
  attachmentId: string,
): Promise<VideoAnalysisRecord | null> {
  if (!dbReady()) return null;
  const { data, error } = await supabase
    .from('video_analyses')
    .select('*')
    .eq('account_id', accountId)
    .eq('attachment_id', attachmentId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as any;
  return {
    title: row.title ?? undefined,
    durationSeconds: Number(row.duration_seconds),
    framesAnalysed: Number(row.frames_analysed) || 0,
    frameTimestamps: (row.frame_timestamps || []).map(Number),
    frameUrls: row.frame_urls || [],
    transcript: Array.isArray(row.transcript) ? row.transcript : [],
    pace: row.pace ?? undefined,
  };
}
