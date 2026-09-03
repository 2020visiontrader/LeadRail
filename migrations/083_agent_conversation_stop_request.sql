-- 083_agent_conversation_stop_request.sql
--
-- THE GAP THIS CLOSES. "Stop" in the product stops nothing on the server.
-- stopAll() in src/components/AgentConsole.tsx only aborts the BROWSER's own
-- fetch to /api/agent/stream — there is no /api/agent/stop route, and no
-- AbortSignal anywhere in lib/agent. After a click, model spend continues,
-- tools keep executing, approved sends still go out, and the conversation
-- stays flagged running (migration 072) for up to RUNNING_STALE_MS, during
-- which the user cannot start a corrected turn on it. Stop currently means
-- "stop watching", not "stop running".
--
-- THE FIX, SAME SHAPE AS MIGRATION 072. One nullable timestamp on the
-- conversation row, exactly the pattern running_since already established:
-- set by a cheap, account-scoped write (the new POST /api/agent/stop route),
-- read by the agent loop's own between-steps check (lib/agent/loop.ts,
-- alongside the existing turnDeadline check — see requestStop/isStopRequested/
-- clearStopRequest in lib/agent/memory.ts), and cleared unconditionally the
-- moment a fresh turn starts on this conversation (the same place
-- markConversationRunning is already called in app/api/agent/route.ts and
-- app/api/agent/stream/route.ts) so a stale stop from a PRIOR turn can never
-- kill a turn that hasn't even started yet.
--
-- Never executes mid-tool-call: the loop only checks this between steps, the
-- same point the deadline check already runs at — a half-executed send is
-- worse than a late one. And it never touches stream-guard.ts's deliberate
-- "keep going when the client disconnects" behaviour — a disconnect is not a
-- stop; this column is set ONLY by an explicit POST to /api/agent/stop, never
-- by a dropped connection.
--
-- No staleness cutoff needed here, unlike running_since: the loop clears this
-- column itself the instant it observes a set value (same transaction as
-- ending the turn), and a fresh turn clears it unconditionally on start
-- regardless of what it finds — so nothing here can be left "stuck" the way
-- an unclearable running_since could be after a crash.

ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS stop_requested_at TIMESTAMPTZ;

COMMENT ON COLUMN agent_conversations.stop_requested_at IS
  'Set by POST /api/agent/stop when a user asks a running turn to stop. Read by the agent loop (lib/agent/loop.ts) between steps, alongside the turnDeadline check, and cleared unconditionally the moment a new turn starts on this conversation (same call site as markConversationRunning, migration 072) so a stale value from a prior turn can never kill a fresh one. Never set by a client disconnect — see lib/agent/stream-guard.ts, which deliberately keeps a turn running after the client goes away; that is a different event from this column entirely.';
