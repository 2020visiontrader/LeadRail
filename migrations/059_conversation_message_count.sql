-- Guard against a conversation being truncated by a failed read.
--
-- THE LOSS THIS PREVENTS. Every turn starts by loading the conversation's
-- transcript, appending the user's new message, and saving the result back over
-- the same row. loadConversation swallows any error and returns null, and
-- loadTranscript turns null into [] — so a single transient read failure made
-- the "existing transcript" empty, and the save that followed replaced a
-- forty-message history with one message. Permanently. Observed twice.
--
-- A count column makes the write conditional in SQL rather than in a comment:
-- the update carries `message_count <= <new count>`, so a shrinking write
-- matches no rows instead of destroying one. It is atomic, needs no extra read
-- on the normal path, and cannot be skipped by a future caller that forgets.
--
-- Backfilled from the stored transcripts so existing rows are protected from
-- the first write after this runs, not from the second.

ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS message_count INT;

COMMENT ON COLUMN agent_conversations.message_count IS
  'Number of messages in transcript. Used as a write guard: a save carrying fewer messages than this is refused, so a failed read cannot truncate a conversation.';

UPDATE agent_conversations
SET message_count = COALESCE(jsonb_array_length(transcript), 0)
WHERE message_count IS NULL
  AND transcript IS NOT NULL
  AND jsonb_typeof(transcript) = 'array';

-- A row whose transcript is not an array has no meaningful count; 0 lets any
-- write through, which is correct — there is nothing there to protect.
UPDATE agent_conversations SET message_count = 0 WHERE message_count IS NULL;
