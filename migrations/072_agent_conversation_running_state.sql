-- 072_agent_conversation_running_state.sql
--
-- THE GAP THIS CLOSES. A turn exists ONLY as an open HTTP connection: there is
-- no server-side record that a run is in progress anywhere (no agent_runs or
-- agent_jobs table). AgentConsole.tsx lives only on /assistant, so navigating
-- away unmounts it; commit 167c5c9 (lib/agent/stream-guard.ts) already fixed
-- the run itself surviving a disconnect and saveConversation persisting the
-- answer server-side, but the CLIENT has no way to know a turn is still
-- running when it comes back. Its mount-time rehydration effect just repaints
-- the last SAVED transcript, which for a run still in flight is the user's
-- question and no answer — indistinguishable from "it stopped". Most-reported
-- complaint about the product.
--
-- THE FIX, DELIBERATELY SMALL. One nullable timestamp on the conversation row
-- already used to hold everything else about a chat (transcript, carryover,
-- message_count, deleted_at — migrations 022/059/069). Not a new table, not a
-- job queue, not SSE reattachment: the answer already always persists via
-- saveConversation's `finally` (now guaranteed to run); the only missing
-- piece is the client being told a turn is still on its way.
--
-- running_since is set the moment a turn starts (in the stream route, once
-- the conversation id is known) and cleared to NULL in that route's `finally`
-- — the same block that already guarantees saveConversation runs whatever
-- happened to the turn. A process that dies before reaching `finally` (a
-- crash, a killed container) leaves running_since set forever, so callers
-- MUST apply a staleness cutoff rather than trusting "non-null" alone — see
-- RUNNING_STALE_MS in lib/agent/memory.ts, kept in sync with this route's
-- maxDuration (300s) plus a buffer, not hardcoded a second time here.

ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS running_since TIMESTAMPTZ;

COMMENT ON COLUMN agent_conversations.running_since IS
  'Set when a turn starts on this conversation, cleared to NULL in the stream route''s finally block when the turn ends. NULL means no turn is known to be running. A non-null value older than RUNNING_STALE_MS (lib/agent/memory.ts) must be treated as stale, not running — a dead process cannot clear this itself.';
