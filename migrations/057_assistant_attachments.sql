-- 057_assistant_attachments.sql — documents dropped into a conversation.
--
-- These are not a file store. They exist to give the assistant CONTEXT: someone
-- drops a brief, a lead list or a competitor's deck into the chat so the next
-- answer is grounded in it. The row therefore carries the extracted TEXT
-- alongside the stored bytes, because the text is the point and the file is the
-- receipt.
--
-- extracted_text is nullable and status says why. A scanned PDF, an image, or a
-- corrupt file all store fine and read as nothing — and the operator has to be
-- told that, because an attachment the model never saw produces a confident
-- answer that ignores the document entirely, with no sign anything went wrong.
--
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS assistant_attachments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Nullable: a file can be dropped before the first message exists, and the
  -- conversation is stamped on once it does.
  conversation_id UUID,

  -- The name the PERSON knows it by. Never used to build a storage path — an
  -- uploaded filename is attacker-controlled and has no business being one.
  filename     TEXT NOT NULL,
  mime_type    TEXT,
  bytes        INTEGER NOT NULL,
  -- Always under an <account_id>/ prefix in a private bucket; that prefix is
  -- what makes per-account privacy enforceable rather than aspirational.
  storage_path TEXT NOT NULL,
  kind         TEXT,

  -- What the model actually reads. Kept in full here even though only part of
  -- it fits in a turn, so a long document stays searchable after the fact.
  extracted_text TEXT,
  chars        INTEGER NOT NULL DEFAULT 0,

  -- ready | image | unreadable. Never silently absent — see the header.
  status       TEXT NOT NULL DEFAULT 'ready',
  note         TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT assistant_attachments_status_check CHECK (
    status IN ('ready', 'image', 'unreadable')
  )
);

CREATE INDEX IF NOT EXISTS idx_assistant_attachments_conversation
  ON assistant_attachments(account_id, conversation_id, created_at DESC);

ALTER TABLE assistant_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.assistant_attachments FROM anon, authenticated;
