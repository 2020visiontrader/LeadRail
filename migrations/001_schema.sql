-- Marketing Agency OS Schema (8 tables)
-- Supabase PostgreSQL

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  logo_url TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id TEXT NOT NULL REFERENCES brands(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  title TEXT,
  segment TEXT,
  engagement_score INT DEFAULT 0,
  status TEXT DEFAULT 'new',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_contacts_brand_id ON contacts(brand_id);
CREATE INDEX idx_contacts_email ON contacts(email);
CREATE INDEX idx_contacts_segment ON contacts(segment);

CREATE TABLE contact_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_data JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_contact_events_contact_id ON contact_events(contact_id);

CREATE TABLE email_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  template_id TEXT,
  subject TEXT,
  body TEXT,
  sent_at TIMESTAMP,
  opened_at TIMESTAMP,
  replied_at TIMESTAMP,
  brevo_id TEXT UNIQUE,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_email_campaigns_contact_id ON email_campaigns(contact_id);
CREATE INDEX idx_email_campaigns_status ON email_campaigns(status);

CREATE TABLE content_calendar (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id TEXT NOT NULL REFERENCES brands(id),
  platform TEXT NOT NULL,
  scheduled_for TIMESTAMP,
  post_body TEXT NOT NULL,
  media_urls TEXT[],
  status TEXT DEFAULT 'draft',
  postiz_id TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_content_calendar_brand_id ON content_calendar(brand_id);
CREATE INDEX idx_content_calendar_platform ON content_calendar(platform);

CREATE TABLE generated_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  content TEXT NOT NULL,
  model_used TEXT,
  generated_at TIMESTAMP DEFAULT NOW(),
  approved_at TIMESTAMP,
  status TEXT DEFAULT 'pending_approval',
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_generated_content_contact_id ON generated_content(contact_id);
CREATE INDEX idx_generated_content_status ON generated_content(status);

CREATE TABLE social_engagement (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  post_id TEXT NOT NULL,
  commenter TEXT NOT NULL,
  comment_text TEXT NOT NULL,
  sentiment TEXT DEFAULT 'neutral',
  response_status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_social_engagement_platform ON social_engagement(platform);
CREATE INDEX idx_social_engagement_sentiment ON social_engagement(sentiment);
