-- 019_venture_persona.sql
-- Sender profile / persona, per venture. A venture is who you ARE when you
-- reach out under that brand: your name, your role there, the address it sends
-- from, a one-line pitch the generator grounds on, a default tone, a signature,
-- and the default ask. These map (in code) into the internal 5-element persona
-- and fix the empty `venture.pitch` grounding gap that was causing the model to
-- invent stats/value props. `skills` (jsonb) already exists from 013; ['auto']
-- means "let the goal box pick the skills". All nullable; safe to re-run.

ALTER TABLE brands ADD COLUMN IF NOT EXISTS sender_name  text;   -- human name: From + signature
ALTER TABLE brands ADD COLUMN IF NOT EXISTS sender_role  text;   -- your role at this venture, e.g. 'Co-founder'
ALTER TABLE brands ADD COLUMN IF NOT EXISTS sender_email text;   -- From / reply-to address for this venture
ALTER TABLE brands ADD COLUMN IF NOT EXISTS pitch        text;   -- one-line value prop the generator grounds on
ALTER TABLE brands ADD COLUMN IF NOT EXISTS tone         text;   -- default voice, e.g. 'direct, warm, professional'
ALTER TABLE brands ADD COLUMN IF NOT EXISTS signature    text;   -- sign-off block appended to drafts
ALTER TABLE brands ADD COLUMN IF NOT EXISTS default_cta  text;   -- the one clear ask when the goal implies none
