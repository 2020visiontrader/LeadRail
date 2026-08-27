-- RENUMBERED 061 -> 064 during integration. 061 was already taken by
-- 061_memory_graph.sql, which is APPLIED IN PRODUCTION; 062 by approval_grants
-- (also applied) and 063 by agent_plans on claude/agent-plans-9ve4f1. Numbering
-- is the only thing that changed — the DDL is untouched.
--
-- Frame and pace data for an uploaded video.
--
-- WHY IT IS NOT A COLUMN ON assistant_attachments. That table stores extracted
-- TEXT — the document is the receipt and the text is the point (see 057). A
-- video's extract is not text: it is a shot structure, a pace measurement, a
-- timestamped transcript and a set of stills. Forcing that into a text column
-- as JSON would make it unqueryable and would quietly change what that column
-- means for every other file type.
--
-- WHY THE EXTRACTION IS ALREADY DONE BY THE TIME A ROW EXISTS. A 10-minute
-- 1080p file is around 150MB against a 25MB upload cap, so the video itself was
-- never going to reach the server. It is decoded in the browser, where the file
-- already is: every frame is read for cuts and motion, one still per shot is
-- kept, and only the stills plus the audio come up. Two orders of magnitude
-- smaller, no ffmpeg in the request path, and the raw footage never leaves the
-- uploader's machine.
--
-- frames_analysed is stored, not derived. It is the difference between "we read
-- all 1,800 frames and 12 shots came out" and "we sampled 12 frames" — the same
-- twelve stills either way, and a completely different claim about the video.

CREATE TABLE IF NOT EXISTS video_analyses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- One analysis per uploaded video. Cascades: the analysis of a deleted
  -- attachment is not a record of anything.
  attachment_id UUID NOT NULL REFERENCES assistant_attachments(id) ON DELETE CASCADE,

  title            TEXT,
  duration_seconds NUMERIC(10, 3) NOT NULL,
  frames_analysed  INT NOT NULL DEFAULT 0,

  -- Timestamps of the stills that were kept, and where they are stored. Two
  -- columns rather than one array of objects so a missing image is a length
  -- mismatch that shows up, rather than a null hiding inside a JSON blob.
  frame_timestamps NUMERIC(10, 3)[] NOT NULL DEFAULT '{}',
  frame_urls       TEXT[] NOT NULL DEFAULT '{}',

  -- [{t, text}] from the transcriber, aligned to the same clock as the frames.
  transcript JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The PaceReport from lib/video/frames.ts — shots, cuts per minute, motion.
  pace       JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT video_analyses_duration_check CHECK (duration_seconds > 0),
  CONSTRAINT video_analyses_frames_check CHECK (frames_analysed >= 0),
  CONSTRAINT video_analyses_one_per_attachment UNIQUE (attachment_id)
);

CREATE INDEX IF NOT EXISTS video_analyses_account
  ON video_analyses(account_id, created_at DESC);

ALTER TABLE video_analyses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.video_analyses FROM anon, authenticated;
