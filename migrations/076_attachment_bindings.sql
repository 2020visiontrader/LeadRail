-- 076_attachment_bindings.sql — attachment provenance that survives a reload.
--
-- THE DEFECT, VERIFIED IN PRODUCTION. assistant_attachments (057) binds an
-- upload to account_id and a nullable conversation_id. There is no
-- message-level binding anywhere. While a turn is live, the composer holds
-- "this file went with this message" in React state and renders a chip for
-- it — reopen the conversation and that binding is gone. "Did you actually
-- read my PDF?" is unanswerable after a reload, because nothing durable ever
-- recorded which exchange a file belonged to.
--
-- There is no agent_messages table. Every message lives inside
-- agent_conversations.transcript (jsonb), and every element there has
-- exactly two keys, `role` and `content` — verified against production by
-- querying every transcript. That is also why this can't be "add a column to
-- the messages table": there is no such table.
--
-- THE CONSTRAINT THAT SHAPES THIS. transcript is not merely message-shaped,
-- it IS the provider wire format: saveConversation (lib/agent/memory.ts)
-- writes it wholesale, typed against ChatMessage, and ChatMessage
-- (lib/ai/opencode.ts, re-exported by lib/ai/router.ts; identical shape in
-- lib/ai/gemini.ts) is declared as exactly `{ role, content }` and gets
-- serialised straight into every provider request. Adding an `id` column to
-- a "messages table" was never on the table (there isn't one) — but even
-- inside the jsonb, an `id` key had to be introduced carefully: it lives on a
-- STORAGE type (StoredMessage, lib/agent/transcript-store.ts) distinct from
-- the WIRE type, stripped at the one place a transcript is handed to a
-- provider (toWireMessages). See that file's header for the full mapping.
--
-- THE DESIGN THIS MIGRATION IMPLEMENTS: stable transcript-entry ids, plus a
-- normalized binding table OUTSIDE the transcript body. That split matters:
-- one uploaded file can be bound to several messages (or to a whole
-- conversation, or to a background task) without duplicating anything inside
-- the transcript jsonb, and releasing a binding later is a row update here,
-- never a rewrite of the conversation's history — so an attachment being
-- unbound cannot corrupt the transcript that mentions it.
--
-- ============================================================================
-- PART 1 — STABLE MESSAGE IDS, BACKFILLED IN PLACE
-- ============================================================================
--
-- Every transcript entry gets an immutable `id` key, added to the existing
-- jsonb object (role/content are untouched). Array POSITION is used exactly
-- ONCE here, as a seed for ORDER BY so existing order is preserved exactly
-- while iterating — it is never stored as identity and never recomputed:
-- the minted uuid is what's written, once, into the `id` key. Same for every
-- other candidate a naive version of this might have reached for — filename,
-- upload timestamp, title — none of those are identity either; only the
-- minted id is.
--
-- THE WRITE RACE THIS ALONE DOES NOT SOLVE. transcript is REPLACED WHOLE on
-- every save (see saveConversation), so this one-time UPDATE can be clobbered
-- by a save that is already in flight: it read an un-backfilled row before
-- this ran, and writes it straight back with no ids, moments after this
-- migration finishes. That is why lib/agent/transcript-store.ts's
-- ensureMessageIds is called from saveConversation itself, on EVERY write,
-- not just here — it preserves any id already present and mints one only for
-- an entry that lacks it. This backfill exists for conversations that are
-- never written again after this migration runs; the write-time guard is
-- what protects everything else, including the exact race described above
-- (whichever save lands last still assigns ids to what's missing them, and
-- keeps whatever ids the other one already assigned).
UPDATE agent_conversations ac
SET transcript = sub.new_transcript
FROM (
  SELECT ac2.id,
         jsonb_agg(
           CASE WHEN elem ? 'id' THEN elem
                ELSE elem || jsonb_build_object('id', gen_random_uuid()::text)
           END ORDER BY ord
         ) AS new_transcript
  FROM agent_conversations ac2,
       jsonb_array_elements(ac2.transcript) WITH ORDINALITY AS t(elem, ord)
  WHERE jsonb_typeof(ac2.transcript) = 'array'
    AND jsonb_array_length(ac2.transcript) > 0
  GROUP BY ac2.id
) sub
WHERE ac.id = sub.id;

-- ============================================================================
-- PART 2 — attachment_bindings: where a file is bound to, durably
-- ============================================================================
--
-- message_id references a transcript-entry id, which lives inside a jsonb
-- array, not a table row — it CANNOT be a foreign key. NULL means the
-- binding is conversation- or task-scoped rather than tied to one exchange
-- (see the scope/message_id CHECK below).
CREATE TABLE IF NOT EXISTS attachment_bindings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  attachment_id   UUID NOT NULL REFERENCES assistant_attachments(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  message_id      UUID,
  scope           TEXT NOT NULL DEFAULT 'message',
  role            TEXT NOT NULL DEFAULT 'user_upload',
  status          TEXT NOT NULL DEFAULT 'bound',
  bound_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at     TIMESTAMPTZ,
  bound_by        TEXT NOT NULL DEFAULT 'user',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE attachment_bindings DROP CONSTRAINT IF EXISTS attachment_bindings_scope_check;
ALTER TABLE attachment_bindings ADD CONSTRAINT attachment_bindings_scope_check
  CHECK (scope IN ('message', 'conversation', 'task'));

ALTER TABLE attachment_bindings DROP CONSTRAINT IF EXISTS attachment_bindings_role_check;
ALTER TABLE attachment_bindings ADD CONSTRAINT attachment_bindings_role_check
  CHECK (role IN ('user_upload', 'library_reference', 'generated', 'tool_output'));

ALTER TABLE attachment_bindings DROP CONSTRAINT IF EXISTS attachment_bindings_status_check;
ALTER TABLE attachment_bindings ADD CONSTRAINT attachment_bindings_status_check
  CHECK (status IN ('bound', 'released', 'failed'));

ALTER TABLE attachment_bindings DROP CONSTRAINT IF EXISTS attachment_bindings_bound_by_check;
ALTER TABLE attachment_bindings ADD CONSTRAINT attachment_bindings_bound_by_check
  CHECK (bound_by IN ('user', 'assistant', 'system'));

-- A 'message'-scoped binding without a message_id is a contradiction in
-- terms — enforce it in SQL, not just in the code that writes this table.
ALTER TABLE attachment_bindings DROP CONSTRAINT IF EXISTS attachment_bindings_message_scope_check;
ALTER TABLE attachment_bindings ADD CONSTRAINT attachment_bindings_message_scope_check
  CHECK (scope <> 'message' OR message_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_attachment_bindings_conversation ON attachment_bindings(conversation_id);
CREATE INDEX IF NOT EXISTS idx_attachment_bindings_attachment ON attachment_bindings(attachment_id);
CREATE INDEX IF NOT EXISTS idx_attachment_bindings_account ON attachment_bindings(account_id);
CREATE INDEX IF NOT EXISTS idx_attachment_bindings_message ON attachment_bindings(conversation_id, message_id) WHERE message_id IS NOT NULL;

-- THE RETRY GUARD — a partial unique index over the LIVE (status='bound')
-- rows, not a code-side check, mirroring the house pattern:
-- uniq_enrichment_job_live_contact / uniq_enrichment_job_live_company
-- (migrations/011_typed_sequencing.sql, 070_company_enrichment_idempotency.sql)
-- — a live-only unique index, resolved to the app catching 23505, so a
-- retried request cannot create a duplicate live row.
--
-- message_id is nullable, and two NULLs are never equal in an ordinary
-- UNIQUE index — a plain UNIQUE(attachment_id, message_id, scope) would let
-- every conversation-scoped binding (message_id NULL) duplicate freely, the
-- exact hole this index exists to close. Folding the NULL into a sentinel via
-- COALESCE puts every conversation-scoped binding for the same attachment
-- into the same key, so THOSE get the same duplicate protection message-scoped
-- ones get from a real message_id.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_attachment_binding_live
  ON attachment_bindings (attachment_id, COALESCE(message_id, '00000000-0000-0000-0000-000000000000'::uuid), scope)
  WHERE status = 'bound';

COMMENT ON TABLE attachment_bindings IS
  'Durable record of which attachment(s) belong to which conversation/message/task. Lives OUTSIDE agent_conversations.transcript on purpose (067''s design note applies here too): one file can bind to several messages without duplicating transcript content, and releasing a binding is a row update here, never a transcript rewrite.';
COMMENT ON COLUMN attachment_bindings.message_id IS
  'A transcript-entry id (migration 076 backfill / lib/agent/transcript-store.ts ensureMessageIds). NOT a foreign key: transcript entries live inside agent_conversations.transcript (jsonb), not a table row. NULL for a conversation- or task-scoped binding.';

-- ============================================================================
-- PART 3 — attachment_evidence: SCHEMA ONLY. Nothing writes this table yet.
-- ============================================================================
--
-- This is deliberately unwired in this pass — see the file header of the
-- task this migration was written for. Recorded here, loudly, so it does not
-- become the next entry in the "written but never read" list: before
-- anything is built against this table, name the writer first.
CREATE TABLE IF NOT EXISTS attachment_evidence (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_binding_id  UUID NOT NULL REFERENCES attachment_bindings(id) ON DELETE CASCADE,
  page                   INT,
  sheet                  TEXT,
  row_start              INT,
  row_end                INT,
  time_start_ms          INT,
  time_end_ms            INT,
  excerpt_hash           TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attachment_evidence_binding ON attachment_evidence(attachment_binding_id);

COMMENT ON TABLE attachment_evidence IS
  'SCHEMA ONLY as of migration 076 — nothing writes this table yet. Meant to eventually record WHERE inside an attachment a claim came from (page/sheet/row/timestamp/excerpt hash), but no capability populates it. Do not build a reader against this table until a writer exists; do not treat its presence as evidence capture being live.';
