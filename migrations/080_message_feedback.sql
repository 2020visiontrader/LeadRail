-- 080_message_feedback.sql — a thumb, keyed to what produced the answer.
--
-- THE GAP THIS CLOSES. This session shipped persona routing (024), a
-- latency-driven model ladder (lib/ai/router.ts, per #9), and batch plans
-- (066, 079) — three real changes to how an answer gets produced — and there
-- is currently NO signal anywhere that says whether any one of them actually
-- made an answer better. Nothing in the schema ties a human's reaction to a
-- message back to the persona that wrote it, the model tier that answered, or
-- the skills that were routed in. Without that join, "did the latency
-- reorder help" and "is persona X actually worth keeping" are both
-- unanswerable except by anecdote.
--
-- THE SHAPE OF THE FIX. One row per (account, message), holding the vote
-- (`up`) alongside a snapshot of the routing metadata that produced the
-- message it is voted on. Columns are chosen so the query this exists to
-- answer is one line:
--
--   SELECT persona_id, AVG(CASE WHEN up THEN 1 ELSE 0 END) AS approval
--   FROM message_feedback
--   WHERE account_id = $1
--   GROUP BY persona_id;
--
-- and the same shape works grouped by model_label, or unnested over
-- skill_slugs, without touching this table's structure.
--
-- WHY message_id IS NOT A FOREIGN KEY. Same constraint migration 076 already
-- documented for attachment_bindings: there is no messages table.
-- agent_conversations.transcript is a jsonb array, and message_id is a
-- transcript-entry id living inside it (StoredMessage.id,
-- lib/agent/transcript-store.ts) — a value inside a jsonb column cannot be a
-- Postgres foreign key target. conversation_id is a real FK (the row it
-- belongs to); message_id is trusted at the application layer, exactly the
-- way attachment_bindings.message_id already is.
--
-- WHAT IS, AND IS NOT, RELIABLY POPULATED AT WRITE TIME — SAID PLAINLY SO
-- THIS DOES NOT BECOME THE NEXT "WRITTEN BUT NEVER READ" ENTRY.
--
--   persona_id   — the persona PINNED for the turn that produced this
--                   message, captured client-side at the moment the message
--                   was appended to the transcript (AgentConsole.tsx) and
--                   sent back with the vote. Real, but partial: it reflects
--                   an explicit pin, not a persona the router chose on its
--                   own — lib/agent/loop.ts's AgentResult does not expose an
--                   effective persona today, and this migration does not
--                   touch loop.ts to add one. NULL for an unpinned turn.
--   model_label  — a best-effort snapshot of ai_usage.model_label
--                  (023_ai_providers.sql, already denormalized there for the
--                  same "survives provider/model deletion" reason) for this
--                  account's most recent usage row at or before the vote,
--                  looked up by the feedback route at write time. ai_usage
--                  has a conversation_id (060) but no message_id, so this is
--                  an approximation at conversation granularity, not an exact
--                  per-message join — documented rather than presented as
--                  more precise than it is.
--   skill_slugs  — HAS A WRITER, as of the same session that added this
--                  column. lib/agent/loop.ts now exposes the turn's routed
--                  skill slugs (selectSkillsForTurn's picks) on
--                  AgentResult.skillSlugs (non-streaming) and on the
--                  streaming 'final' AgentEvent, computed identically in both
--                  loops. Both API routes (app/api/agent/route.ts,
--                  app/api/agent/stream/route.ts) hand the slugs to the
--                  client alongside lastMessageId; AgentConsole.tsx stashes
--                  them on the turn and forwards them on a vote;
--                  recordMessageFeedback (lib/agent/feedback.ts) writes them
--                  here. Same reliability caveat as persona_id above: real
--                  for a turn the client just completed this session, NULL
--                  for a rehydrated (post-reload) turn nothing re-fetches it
--                  for — the client never invents a value, it only forwards
--                  what the server computed for that turn.
--
-- ONE VOTE PER MESSAGE PER ACCOUNT, CHANGEABLE. A plain UNIQUE constraint
-- (not a partial "live rows only" index like 076's — there is no soft-delete
-- state here, a vote is either the current one or it does not exist) plus an
-- upsert (ON CONFLICT DO UPDATE) in the API route is what makes flipping a
-- vote an UPDATE, never a second row.

CREATE TABLE IF NOT EXISTS message_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  -- Transcript-entry id (StoredMessage.id / migration 076). Not a foreign
  -- key — see the header above.
  message_id      UUID NOT NULL,
  up              BOOLEAN NOT NULL,               -- true = thumbs up, false = thumbs down
  persona_id      UUID REFERENCES personas(id) ON DELETE SET NULL,
  model_label     TEXT,
  skill_slugs     TEXT[],
  voted_by        TEXT,                            -- session.email at vote time, for audit only
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- THE "CHANGEABLE, NOT APPEND-ONLY" GUARD. One live vote per message per
-- account — the API route's upsert targets exactly this constraint.
ALTER TABLE message_feedback DROP CONSTRAINT IF EXISTS uniq_message_feedback_vote;
ALTER TABLE message_feedback ADD CONSTRAINT uniq_message_feedback_vote
  UNIQUE (account_id, message_id);

-- The two queries this table exists to answer: "how is this account's chat
-- landing overall / per conversation" (account_id, created_at) and the
-- persona/model rollups the header above shows. Partial on persona_id /
-- model_label because a NULL-heavy column benefits from excluding the NULLs
-- from the index rather than indexing a value nobody will filter or group by
-- as NULL.
CREATE INDEX IF NOT EXISTS idx_message_feedback_account ON message_feedback(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_feedback_conversation ON message_feedback(conversation_id);
CREATE INDEX IF NOT EXISTS idx_message_feedback_persona ON message_feedback(persona_id) WHERE persona_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_message_feedback_model ON message_feedback(model_label) WHERE model_label IS NOT NULL;

-- RLS: on, no anon policies — the app connects with the service-role key
-- (lib/db.ts) which bypasses RLS, and every read/write is scoped by
-- account_id in code (see app/api/agent/feedback/route.ts). Same convention
-- as 024/041/062 and every other account-owned table in this schema.
ALTER TABLE public.message_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.message_feedback FROM anon, authenticated;

COMMENT ON TABLE message_feedback IS
  'One thumbs up/down per (account, message), snapshotting the routing metadata (persona/model/skills) that produced the message, so persona/model/skill choices can be measured against real reactions rather than assumed. See the file header for exactly what is and is not populated at write time.';
COMMENT ON COLUMN message_feedback.message_id IS
  'A transcript-entry id (migration 076 backfill / lib/agent/transcript-store.ts). NOT a foreign key: transcript entries live inside agent_conversations.transcript (jsonb), not a table row.';
COMMENT ON COLUMN message_feedback.persona_id IS
  'The persona PINNED for the turn that produced this message (captured client-side at message-append time), not necessarily the persona the router chose unprompted. NULL for an unpinned turn.';
COMMENT ON COLUMN message_feedback.model_label IS
  'Best-effort snapshot of ai_usage.model_label for this conversation at vote time (conversation granularity — ai_usage has no message_id). NULL when no usage row could be matched.';
COMMENT ON COLUMN message_feedback.skill_slugs IS
  'Routed skill slugs for the turn that produced this message, exposed on AgentResult.skillSlugs / the streaming final event by lib/agent/loop.ts and written here by lib/agent/feedback.ts (recordMessageFeedback). Same reliability caveat as persona_id: real for a turn just completed this session, NULL for a rehydrated turn.';
