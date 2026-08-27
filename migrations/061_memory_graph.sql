-- 061_memory_graph.sql — subject-scoped, bitemporal memory.
--
-- WHY THIS EXISTS
--
-- `agent_memory` (migration 022) is one flat pool per account: a `fact` string,
-- an embedding, and `account_id`. It has three limits that matter for an
-- assistant that acts autonomously:
--
--   1. No subject. A fact about one contact is indistinguishable from a fact
--      about the whole account, so retrieval can only ever be "semantically
--      near the question", never "what do we know about THIS deal".
--   2. No time. A new fact overwrites nothing and supersedes nothing, so
--      "budget is $40k" and "budget is $65k" both sit there as equals and the
--      negotiation history is unrecoverable.
--   3. No calibration. Every extracted string is written with equal weight, so
--      a passing remark and a signed commitment are the same kind of thing.
--
-- This migration adds the two tables that fix those, and deliberately does NOT
-- touch `agent_memory` — rememberFact/forgetFact/listFacts keep working exactly
-- as they do today. Unifying the two is a later step, once edges have real data.
-- (This codebase's recurring failure is schema written and never wired; the
-- answer to that is fewer moving parts per change, not more.)
--
-- WHY POSTGRES AND NOT A GRAPH DATABASE
--
-- The design this implements is a temporal knowledge graph (the Graphiti model:
-- edges carry validity intervals, contradiction invalidates rather than
-- deletes). Adopting Graphiti itself would mean a Python runtime plus Neo4j or
-- FalkorDB alongside a TypeScript app on Supabase — a second datastore with its
-- own auth, tenancy, backups and egress, to serve an account whose entire CRM is
-- tens of contacts. Traversal depth here is 2-3 hops, which is a recursive CTE.
-- The temporal model is the valuable part, and it is forty lines of DDL.
--
-- NOTE: "Graphify" (the harvested skill in this repo) is a code-graph developer
-- tool for analysing source trees. It is unrelated to this and cannot serve as
-- CRM memory; see docs/MEMORY_ARCHITECTURE.md.

-- ---------------------------------------------------------------------------
-- memory_edges — the source of truth. Append-mostly; rows are invalidated,
-- never updated in place, and never deleted by the extraction path.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_edges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  -- POLYMORPHIC SUBJECT, AND WHY subject_id IS TEXT.
  -- `brands.id` is TEXT while `contacts.id`, `deals.id`, `companies.id` and
  -- `ad_campaigns.id` are UUID. A single column that can point at any of them
  -- has to be the wider type. No foreign key, deliberately: polymorphic
  -- references cannot carry one, and a memory row is an audit fact that must
  -- outlive the record it describes — the same reasoning as
  -- ai_usage.conversation_id in migration 060.
  subject_type    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,

  -- The triple. `fact` is the human-readable rendering that reaches a prompt;
  -- predicate/object are what make contradiction detectable, because
  -- "the same thing was said differently" is only decidable on a normalised
  -- predicate, never on free prose.
  predicate       TEXT NOT NULL,
  object          TEXT NOT NULL,
  fact            TEXT NOT NULL,

  -- 1 = durable on first mention (identity, decision, commitment, stated
  -- requirement, measured outcome). 2 = pattern candidate, NOT yet something
  -- the system may act on autonomously. Tier 3 is not a value: excluded content
  -- is discarded at extraction and never reaches this table at all.
  tier            SMALLINT NOT NULL,

  -- BITEMPORAL. `valid_from` is when the fact became true in the world (which
  -- may predate when we learned it); `invalid_at` is when it stopped being
  -- true. NULL invalid_at = currently active. A superseding edge sets these on
  -- the old row and records its own id in invalidated_by, so
  -- "what did we believe on 1 August" stays answerable — which is what makes an
  -- autonomous action auditable months later.
  valid_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invalid_at      TIMESTAMPTZ,
  invalidated_by  UUID REFERENCES memory_edges(id) ON DELETE SET NULL,

  -- Provenance. No orphaned facts: if it cannot be traced to the conversation
  -- it came from, it should not have been written.
  conversation_id UUID,
  source          TEXT NOT NULL DEFAULT 'extraction',

  -- How many independent times this has been observed. The Tier 2 promotion
  -- threshold reads this; a repeated observation bumps it rather than inserting
  -- a duplicate edge.
  occurrences     INT NOT NULL DEFAULT 1,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT memory_edges_tier_check CHECK (tier IN (1, 2)),
  -- 'declared' is USER-AUTHORED context — "this is who we are, this is how we
  -- work" — as distinct from anything the system inferred. It is authoritative
  -- by construction and extraction may never supersede it (see writeEdge).
  -- This is the cold-start layer: derived memory is empty until conversations
  -- have happened, declared context works on turn one.
  CONSTRAINT memory_edges_source_check CHECK (source IN ('extraction', 'capability', 'import', 'declared')),
  CONSTRAINT memory_edges_subject_type_check CHECK (subject_type IN (
    'contact', 'company', 'deal', 'campaign', 'segment',
    'channel', 'creative_asset', 'brand', 'account', 'pattern'
  ))
);

-- The hot path: active edges for one subject, newest first. Partial on
-- invalid_at so the index only carries what retrieval actually reads.
CREATE INDEX IF NOT EXISTS idx_memory_edges_subject_active
  ON memory_edges(account_id, subject_type, subject_id, valid_from DESC)
  WHERE invalid_at IS NULL;

-- Contradiction lookup: "is there an active edge for this subject+predicate".
CREATE INDEX IF NOT EXISTS idx_memory_edges_predicate_active
  ON memory_edges(account_id, subject_type, subject_id, predicate)
  WHERE invalid_at IS NULL;

-- The promotion queue: Tier 2 edges that have recurred.
CREATE INDEX IF NOT EXISTS idx_memory_edges_tier2
  ON memory_edges(account_id, occurrences DESC)
  WHERE tier = 2 AND invalid_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_edges_conversation
  ON memory_edges(conversation_id)
  WHERE conversation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- memory_subjects — a generated projection, one row per subject.
--
-- This is what a live turn reads: one keyed fetch, no traversal, same latency
-- shape as the existing recall. It is derived state and can be rebuilt from
-- memory_edges at any time; nothing should ever write to it by hand.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_subjects (
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subject_type    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,

  -- Display name at last projection, so a prompt can say "Jane Doe" without
  -- joining back to contacts on the hot path.
  label           TEXT,
  -- The rendered block spliced into the prompt.
  body            TEXT NOT NULL DEFAULT '',
  edge_count      INT NOT NULL DEFAULT 0,

  -- Optimistic concurrency. Two extraction runs touching the same subject must
  -- not silently clobber each other, and a live read must never see a
  -- half-written body. Projection reads this version and writes conditionally
  -- on it; a mismatch means re-project rather than overwrite.
  version         INT NOT NULL DEFAULT 1,
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (account_id, subject_type, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_subjects_account
  ON memory_subjects(account_id, last_synced_at DESC);

-- ---------------------------------------------------------------------------
-- Provenance on the extraction watermark. `agent_conversations` already holds
-- every episode (the full transcript), so no separate episodes table is needed
-- — but the extractor must know where it left off, or it re-reads the whole
-- history on every tick.
-- ---------------------------------------------------------------------------
ALTER TABLE agent_conversations
  ADD COLUMN IF NOT EXISTS memory_extracted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_agent_conversations_pending_extract
  ON agent_conversations(account_id, updated_at)
  WHERE memory_extracted_at IS NULL;

COMMENT ON TABLE memory_edges IS
  'Bitemporal subject-scoped memory. Source of truth. Edges are invalidated, never overwritten or deleted, so historical belief stays queryable.';
COMMENT ON TABLE memory_subjects IS
  'Generated projection of memory_edges active rows, one per subject. Read by the live agent turn. Derived — safe to rebuild.';
COMMENT ON COLUMN agent_conversations.memory_extracted_at IS
  'Watermark for the async extraction job. NULL = this conversation has content the extractor has not yet processed.';

-- RLS parity with the rest of the schema (service-role bypasses; the app scopes
-- every query by account_id).
ALTER TABLE memory_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_subjects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_edges FROM anon, authenticated;
REVOKE ALL ON public.memory_subjects FROM anon, authenticated;
