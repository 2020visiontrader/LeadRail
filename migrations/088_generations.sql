-- 088_generations.sql — a place to see what the assistant has generated.
--
-- THE DEFECT THIS CLOSES. Migrations 086/087 (this same packet series) moved
-- every generated image/video off `public/generated/` and onto
-- lib/storage.ts's private, tenant-prefixed GENERATED_BUCKET, uploaded through
-- uploadGenerated(). That closed the storage leak, but nothing records that a
-- generation ever HAPPENED: generateBrandImage, generateImage,
-- POST /api/generate/image, and generateBrandVideo all upload (or, for
-- Higgsfield video, point at) a file and hand the URL straight back into
-- chat — no row, anywhere, survives the turn. There is no way to list what
-- was made, no way to review or reject it, no per-account quota, and no
-- retention policy: a runaway loop of image generations has an unbounded
-- private bucket and nobody would know until the Supabase Storage bill did.
-- The owner asked for a place to see generations and approve or reject them;
-- this table is that place.
--
-- SCOPE. Media only (image/video). Text content already has a review surface
-- — content_items and its IDEATION → ... → PUBLISHED lifecycle
-- (lib/content/store.ts) — building a second one for text would duplicate
-- it, not close a gap.
CREATE TABLE IF NOT EXISTS generations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Nullable to match every other table in this schema (content_items,
  -- character_refs, campaign_assets): the platform has to work before a
  -- venture exists, and a generation belonging to no particular brand is
  -- legitimate (e.g. ad-hoc creative from generateImage with no campaignId).
  brand_id        TEXT REFERENCES brands(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  -- Which capability/route made it — generateBrandImage, generateImage,
  -- POST /api/generate/image, generateBrandVideo — so a listing can be
  -- filtered or explained without guessing from other columns.
  source_tool     TEXT NOT NULL,
  prompt          TEXT,
  model           TEXT,
  -- Bucket-relative path in lib/storage.ts's GENERATED_BUCKET, when this app
  -- generated and stored the bytes. NULL for a video Higgsfield hosts
  -- externally — there is no app-owned storage object to path to.
  storage_path    TEXT,
  -- The Higgsfield-hosted URL for a video this app did not upload anywhere.
  -- Like storage_path/image_url on character_refs and campaign_assets, this
  -- is a genuinely external URL with no signed-URL lifecycle of our own —
  -- read it directly, never re-sign it.
  external_url    TEXT,
  mime_type       TEXT,
  bytes           BIGINT NOT NULL DEFAULT 0,
  review_state    TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (review_state IN ('PENDING', 'APPROVED', 'REJECTED')),
  review_note     TEXT,
  reviewed_at     TIMESTAMPTZ,
  -- Set by promoteGenerationToContent once an approved asset is queued for
  -- posting, linking this row to the content board without this table ever
  -- writing content_items directly.
  content_item_id UUID REFERENCES content_items(id) ON DELETE SET NULL,
  -- WHY A COLUMN, NOT A COMPUTED "age > N days" CHECK: retention has to stop
  -- counting the moment a human approves an asset — an approved generation is
  -- a kept asset, not garbage, and must never be swept regardless of how old
  -- it gets. Age alone cannot express that; reviewGeneration('APPROVED')
  -- clears this column to NULL (purgeExpiredGenerations then never matches
  -- it), while a rejection leaves it set so rejects age out on schedule. The
  -- column IS the policy: "when this row should be purged", not "when it was
  -- created".
  --
  -- REVISED DURING REVIEW (owner correction): expires_at governs the ROW.
  -- Separately, the ROW and the STORED OBJECT have different lifetimes —
  -- published_at/purged_at/channel_url below govern the OBJECT once a
  -- generation goes out on a channel.
  expires_at      TIMESTAMPTZ,
  -- Set when a generation is confirmed live on a channel (a real, platform-
  -- returned or platform-constructible permalink is known for it) — see
  -- markGenerationPublished in lib/generations/store.ts, wired from
  -- publishSocialPost (lib/capabilities/social.ts). NULL until then.
  published_at    TIMESTAMPTZ,
  -- When purgeExpiredGenerations dropped OUR COPY of a published asset's
  -- bytes (storage_path set to NULL at the same time). The ROW SURVIVES —
  -- prompt, model, review history and channel_url remain — only the object
  -- is gone. NULL means our copy still exists (or the generation was never
  -- published).
  purged_at       TIMESTAMPTZ,
  -- The permalink to the published post. Required before purging a
  -- published generation's bytes: once we delete our copy, this is the ONLY
  -- place left to point a user who asks for the file back — a purged row
  -- with no channel_url is a dead end and must never happen (enforced in
  -- application code: markGenerationPublished requires a URL, and the purge
  -- query only matches rows where this is set).
  channel_url     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The two read shapes listGenerations/accountStorageBytes actually issue:
-- "this account's generations, newest first, optionally scoped to a brand"
-- and "how many of this account's generations are in each review state".
CREATE INDEX IF NOT EXISTS idx_generations_scope
  ON generations(account_id, brand_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generations_review_state
  ON generations(account_id, review_state);

-- RLS posture matching every table in this file (024/041/050/062/079/080/
-- 081/086/087): on, no anon/authenticated policies — the app connects with
-- the service-role key (lib/db.ts) which bypasses RLS, and every read/write
-- is scoped by account_id in application code (lib/generations/store.ts).
ALTER TABLE public.generations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.generations FROM anon, authenticated;

COMMENT ON COLUMN generations.storage_path IS
  'Bucket-relative path in lib/storage.ts''s GENERATED_BUCKET. A signed URL is minted from this at READ time (resolveGenerationUrl) and NEVER persisted — same invariant as character_refs.storage_path / campaign_assets.storage_path. NULL when external_url is set instead (a Higgsfield-hosted video).';
COMMENT ON COLUMN generations.external_url IS
  'A genuinely externally-hosted URL (Higgsfield video) with no app-owned storage object behind it. Read directly, never re-signed. NULL when storage_path is set instead.';
COMMENT ON COLUMN generations.bytes IS
  'Size of the stored object, for accountStorageBytes()/assertGenerationQuota(). 0 for an externally-hosted video (Higgsfield hosts it — it consumes none of this account''s Supabase Storage and must not count against GENERATION_QUOTA_BYTES).';
COMMENT ON COLUMN generations.expires_at IS
  'When purgeExpiredGenerations() may delete this ROW and its storage object outright. Set to now() + GENERATION_RETENTION_DAYS on insert (PENDING); cleared to NULL on APPROVED (a kept-for-later asset is never garbage-collected while it waits to go out); left set on REJECTED so rejects age out. NULL for any APPROVED row, published or not — a published row is instead governed by published_at/purged_at below, which drop only the OBJECT, never the row.';
COMMENT ON COLUMN generations.content_item_id IS
  'Set by promoteGenerationToContent when an approved generation is queued for posting. Links to content_items without this table (or lib/generations/store.ts) ever writing content_items directly — createContentItem/updateContentItem in lib/capabilities/content.ts own that write.';
COMMENT ON COLUMN generations.published_at IS
  'Set once a real channel permalink is known for this generation (see channel_url). Starts the GENERATION_PUBLISH_GRACE_DAYS grace window after which purgeExpiredGenerations drops our stored copy — the channel becomes the system of record; the user retrieves the asset from there.';
COMMENT ON COLUMN generations.purged_at IS
  'When our stored copy of a PUBLISHED generation was dropped (storage_path set to NULL at the same time). The row is kept permanently as a record of what was made and where it now lives; only the object is gone. NULL means our copy still exists.';
COMMENT ON COLUMN generations.channel_url IS
  'Permalink to the published post. Required before the object can ever be purged — see purged_at. A row with purged_at set and channel_url NULL is a defect (a dead end with nowhere to send the user), never produced by application code.';
