-- 056_support_tickets.sql — the board where failures, feedback and bugs land.
--
-- WHY THE COLUMNS ARE NOT STOCK JIRA. A normal board assumes a human reporter
-- who already knows what is wrong and is deciding whether to do it. Here most
-- reporters are machines that know only that something threw. So the work at
-- the FRONT of this board is establishing what happened, not deciding whether
-- it is worth doing, and the states reflect that:
--
--   triage      Filed, unassessed. Auto-created from a failed log, or by a
--               person leaving feedback. Nothing has looked at it yet.
--   diagnosed   Root-caused, with evidence: which route, which error class,
--               how often, since when. Still no fix. Many tickets die here
--               legitimately — "401 before OAuth completes" is diagnosed and
--               then closed, never fixed.
--   proposed    A concrete change is on the table, awaiting a human decision.
--               NOTHING IS EVER APPLIED FROM THIS STATE AUTOMATICALLY.
--   accepted    A human approved the direction. Work is happening.
--   verifying   The change is live and we are watching whether the original
--               signal stops. This is the column most boards omit and the one
--               this board needs most — see below.
--   resolved    The failure stopped recurring for a defined window.
--   wont_fix    Declined, duplicate, external, or expected. This state has to
--               exist or the board silently accumulates noise until nobody
--               reads it, which is the normal way an alerting system dies.
--
-- WHY `verifying` EARNS ITS COLUMN. For a machine-filed ticket, the signal that
-- created it is the same signal that proves it fixed. A ticket moved straight
-- from "accepted" to "resolved" is someone asserting the fix worked; a ticket
-- that sat in "verifying" and saw no new occurrences has evidence. That
-- distinction is the entire value of filing these automatically — otherwise
-- this is a to-do list that happens to be populated by errors.
--
-- THE PROPERTY THAT MAKES THIS USABLE AT ALL: fingerprint dedup. One incident
-- in this system's own history produced 9,090 rejected webhooks. Nine thousand
-- cards is not a board, it is an outage of the board. Identical failures
-- collapse onto ONE ticket whose occurrence count rises — and a count that
-- climbs after a fix is deployed is itself the signal that the fix did not
-- work.
--
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS support_tickets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable, like app_logs: failures arrive from cron and unauthenticated
  -- contexts that belong to no tenant, and those are often the important ones.
  -- Deliberately not a foreign key for the same reason app_logs is not — a
  -- ticket must outlive the account it came from.
  account_id  UUID,

  -- The dedup key. A stable hash of the failure's SHAPE (route + status +
  -- normalised message), not its text — ids, timestamps and counts are
  -- stripped before hashing so "lead 41f2 not found" and "lead 9ab3 not found"
  -- are one ticket. Null for human-filed tickets, which must never merge:
  -- two people reporting the same thing in different words is two opinions,
  -- and collapsing them loses one.
  fingerprint TEXT,

  source      TEXT NOT NULL,          -- 'log' | 'feedback' | 'manual' | 'assistant'
  status      TEXT NOT NULL DEFAULT 'triage',
  severity    TEXT NOT NULL DEFAULT 'normal',

  title       TEXT NOT NULL,
  -- What was observed, in the reporter's own terms. For a log-filed ticket
  -- this is the error as it appeared, kept verbatim — a paraphrase of an error
  -- is a second-hand account of the only hard evidence there is.
  detail      TEXT,

  -- Where it came from, so a card can be traced back rather than believed.
  route       TEXT,
  status_code INTEGER,
  sample_log_ids UUID[] NOT NULL DEFAULT '{}',

  -- Dedup bookkeeping. occurrences is the number that makes a board of
  -- machine-filed tickets triageable: 9,000 tells you where to look, and a
  -- first_seen from three months ago tells you it is not a regression.
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The triage agent's assessment. Separate columns rather than one blob
  -- because these are read on a card at a glance and queried on the board.
  diagnosis   TEXT,
  -- Whether the agent believes this is mechanically fixable, and how far it
  -- got. NEVER a licence to act — see proposed_fix.
  fixability  TEXT,                   -- 'config' | 'code' | 'external' | 'expected' | 'unknown'
  -- The concrete change being proposed, in prose a reviewer can judge.
  -- A PROPOSAL ONLY. Nothing in this system applies it: an agent that edits
  -- production in response to production errors is one bad diagnosis away from
  -- turning a small failure into a deploy, and the audit trail would show a
  -- machine approving its own work.
  proposed_fix TEXT,
  confidence  TEXT,                   -- 'low' | 'moderate' | 'high'

  -- Set when the fix goes live, so `verifying` can ask the only question that
  -- matters: has it recurred SINCE this moment?
  fix_deployed_at TIMESTAMPTZ,

  assignee    TEXT,
  resolution  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT support_tickets_status_check CHECK (
    status IN ('triage','diagnosed','proposed','accepted','verifying','resolved','wont_fix')
  ),
  CONSTRAINT support_tickets_source_check CHECK (
    source IN ('log','feedback','manual','assistant')
  ),
  CONSTRAINT support_tickets_severity_check CHECK (
    severity IN ('low','normal','high','critical')
  ),
  CONSTRAINT support_tickets_fixability_check CHECK (
    fixability IS NULL OR fixability IN ('config','code','external','expected','unknown')
  ),
  CONSTRAINT support_tickets_confidence_check CHECK (
    confidence IS NULL OR confidence IN ('low','moderate','high')
  )
);

-- The dedup guarantee, enforced by the database rather than by the code that
-- inserts. A UNIQUE index is the only version of this that survives two cron
-- ticks racing each other, which is exactly when a burst of identical failures
-- arrives. Partial, because human-filed tickets carry no fingerprint and must
-- never collapse into each other.
CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_fingerprint_key
  ON support_tickets(fingerprint) WHERE fingerprint IS NOT NULL;

-- The board read: everything not yet closed, newest activity first.
CREATE INDEX IF NOT EXISTS idx_support_tickets_board
  ON support_tickets(status, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_account
  ON support_tickets(account_id, created_at DESC);

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.support_tickets FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- The audit trail.
--
-- Every move on the board, and who made it. Kept separate from the ticket
-- rather than as a status field's history because the question this answers is
-- "who decided this was fine?" — and on a board where a machine can propose
-- but only a person can accept, that question has to be answerable months
-- later without relying on anyone's memory.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_ticket_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,           -- 'created' | 'status' | 'diagnosis' | 'proposal' | 'note' | 'recurrence'
  -- 'agent' or an operator's email. Never blank: an unattributed state change
  -- on this board is indistinguishable from a machine having done it quietly.
  actor      TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  body       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_ticket_events_ticket
  ON support_ticket_events(ticket_id, created_at DESC);

ALTER TABLE support_ticket_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.support_ticket_events FROM anon, authenticated;
