-- 067_document_library.sql — make an uploaded document outlive its chat.
--
-- THE GAP. assistant_attachments is read by listAttachments(accountId,
-- conversationId), so a file is visible only inside the chat it was dropped
-- into. Drop a brand book in one conversation and the next one has never heard
-- of it. There is no account-level place a user can put material for the
-- assistant to draw on, and the knowledge tools reach OUTWARD to Notion and
-- Drive rather than to anything of the user's own.
--
-- That matters more now than it did. The assistant plans, works across ticks,
-- and generates content — all of which should be conditioned on the same source
-- material every time, not on whatever happened to be dropped into the chat
-- that is running.
--
-- WHY A SCOPE COLUMN AND NOT A NEW TABLE. The row is identical either way:
-- same storage path, same extraction, same text. What differs is reach. A
-- second table would duplicate the ingestion path and give two places for
-- extraction to drift — the failure this codebase has produced repeatedly.

ALTER TABLE assistant_attachments
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'conversation';

-- 'conversation' — visible only in the chat it was uploaded to. The default,
--                  and the behaviour of every existing row.
-- 'library'      — account-wide. Available to every chat, every plan, and every
--                  scheduled run on the account.
ALTER TABLE assistant_attachments
  DROP CONSTRAINT IF EXISTS assistant_attachments_scope_check;
ALTER TABLE assistant_attachments
  ADD CONSTRAINT assistant_attachments_scope_check CHECK (scope IN ('conversation', 'library'));

-- A short human label, so a library entry can be referred to by what it IS
-- ("the brand book") rather than by a filename someone's phone chose.
ALTER TABLE assistant_attachments ADD COLUMN IF NOT EXISTS title TEXT;

-- The library lookup: everything account-wide, newest first. Partial, because
-- the library is a small slice of a table that is mostly chat attachments.
CREATE INDEX IF NOT EXISTS idx_attachments_library
  ON assistant_attachments(account_id, created_at DESC)
  WHERE scope = 'library';

-- Substring search over extracted text. Not a full-text index on purpose: the
-- corpus here is tens of documents per account, ILIKE is entirely adequate at
-- that size, and a tsvector column would need a trigger to stay current — one
-- more thing to write and forget to wire.
CREATE INDEX IF NOT EXISTS idx_attachments_account_text
  ON assistant_attachments(account_id)
  WHERE extracted_text IS NOT NULL;

COMMENT ON COLUMN assistant_attachments.scope IS
  'conversation = visible only in its own chat (default). library = account-wide, available to every chat, plan and scheduled run.';
COMMENT ON COLUMN assistant_attachments.title IS
  'Optional human label for a library document, so it can be referred to by what it is rather than by its filename.';
