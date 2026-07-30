export type Segment = 'investor' | 'vc' | 'angel' | 'founder' | 'media' | 'partner' | 'other';
export const SEGMENTS: Segment[] = ['investor', 'vc', 'angel', 'founder', 'media', 'partner', 'other'];

export type ContactStatus = 'new' | 'outreaching' | 'replied' | 'qualified' | 'dead';
export const CONTACT_STATUSES: ContactStatus[] = ['new', 'outreaching', 'replied', 'qualified', 'dead'];
export type EmailStatus = 'draft' | 'sent' | 'opened' | 'replied' | 'bounced';
export type ContentStatus = 'draft' | 'pending_approval' | 'approved' | 'scheduled' | 'published' | 'failed';
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed';
export type Platform = 'instagram' | 'tiktok' | 'linkedin' | 'twitter' | 'facebook' | 'threads' | 'reddit' | 'youtube';

export interface Contact {
  id: string;
  brand_id: string;
  name: string;
  email: string;
  company?: string;
  company_id?: string | null;
  title?: string;
  segment: Segment;
  score: number;
  status: ContactStatus;
  notes?: string;
  account_id?: string;
  source?: string;
  linkedin_url?: string | null;
  enriched?: Record<string, any> | null;
  enrichment_status?: 'none' | 'pending' | 'done' | 'failed';
  fit_verdict?: 'good_fit' | 'maybe' | 'skip' | null;
  created_at: string;
  updated_at?: string;
}

export interface EmailCampaign {
  id: string;
  contact_id: string;
  template_id?: string;
  subject?: string;
  body?: string;
  status: EmailStatus;
  brevo_id?: string;
  sent_at?: string;
  opened_at?: string;
  replied_at?: string;
  created_at: string;
}

// Mirrors content_calendar (schema is source of truth)
export interface ContentPost {
  id: string;
  brand_id: string;
  platform: Platform;
  post_body: string;
  media_urls?: string[];
  scheduled_for?: string;
  status: ContentStatus;
  postiz_id?: string;
  created_at: string;
}

// Mirrors ad_campaigns
export interface AdCampaign {
  id: string;
  brand_id: string;
  name: string;
  channel?: string;
  budget: number;
  spend: number;
  start_date?: string;
  end_date?: string;
  status: CampaignStatus;
  created_at: string;
}

export type HermesTrigger = 'new_contact' | 'high_score' | 'no_engagement' | 'manual';
export type HermesAction = 'send_email' | 'add_tag' | 'update_score' | 'create_task';

export interface HermesStep {
  order: number;
  action: HermesAction;
  config: Record<string, any>;
  delay?: number; // minutes before this step runs
}

export interface HermesSequence {
  id: string;
  brand_id: string;
  name: string;
  trigger: HermesTrigger;
  steps: HermesStep[];
  is_active: boolean;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Multi-tenant + module types (migration 004)
// ---------------------------------------------------------------------------
export type AccountPlan = 'free' | 'pro' | 'enterprise';
export type MemberRole = 'owner' | 'admin' | 'member';
export type IntegrationProvider =
  | 'apollo' | 'brevo' | 'resend' | 'meta' | 'google_ads'
  | 'instagram' | 'tiktok' | 'linkedin' | 'twitter' | 'facebook' | 'youtube' | 'gmail' | 'outlook' | 'imap';
export type ConnectionStatus = 'disconnected' | 'connected' | 'error';
export type LeadSource = 'manual' | 'apollo' | 'import';
export type EnrichmentStatus = 'none' | 'pending' | 'done' | 'failed';
export type FitVerdict = 'good_fit' | 'maybe' | 'skip';
export type EnrollmentStatus = 'active' | 'completed' | 'paused' | 'replied' | 'bounced';
export type AssetKind = 'image' | 'video';
export type AssetStatus = 'raw' | 'approved' | 'cleaned' | 'rejected';

export interface Account {
  id: string;
  name: string;
  plan: AccountPlan;
  created_at: string;
}

export interface AccountMember {
  id: string;
  account_id: string;
  user_id?: string;
  email: string;
  role: MemberRole;
  created_at: string;
}

export interface IntegrationConnection {
  id: string;
  account_id: string;
  provider: IntegrationProvider;
  status: ConnectionStatus;
  secret_ref?: string;
  meta: Record<string, any>;
  created_at: string;
  updated_at?: string;
}

export interface ApolloQuery {
  industry?: string;
  titles?: string[];
  seniority?: string[];
  location?: string;
  company_size?: string;
  keywords?: string;
  limit?: number;
}

export interface ApolloSearch {
  id: string;
  account_id: string;
  brand_id: string;
  query: ApolloQuery;
  status: 'pending' | 'running' | 'done' | 'failed';
  result_count: number;
  created_at: string;
}

export interface Sequence {
  id: string;
  account_id: string;
  brand_id: string;
  name: string;
  channel: 'email';
  is_active: boolean;
  created_at: string;
}

export interface SequenceStep {
  id: string;
  sequence_id: string;
  step_order: number;
  delay_hours: number;
  template_id?: string;
  subject?: string;
  body?: string;
  created_at: string;
}

export interface SequenceEnrollment {
  id: string;
  sequence_id: string;
  contact_id: string;
  current_step: number;
  status: EnrollmentStatus;
  next_run_at?: string;
  last_event?: string;
  created_at: string;
}

export interface MessageTemplate {
  id: string;
  account_id: string;
  brand_id?: string;
  name: string;
  category?: string;
  subject?: string;
  body: string;
  created_at: string;
}

export interface EmailAccount {
  id: string;
  account_id: string;
  provider: 'gmail' | 'outlook' | 'imap' | 'brevo' | 'resend';
  address: string;
  status: ConnectionStatus;
  secret_ref?: string;
  created_at: string;
}

export interface InboxMessage {
  id: string;
  account_id: string;
  email_account_id?: string;
  contact_id?: string;
  thread_id?: string;
  direction: 'inbound' | 'outbound';
  from_addr?: string;
  to_addr?: string;
  subject?: string;
  body?: string;
  is_read: boolean;
  received_at: string;
}

export interface CampaignAsset {
  id: string;
  campaign_id: string;
  account_id: string;
  kind: AssetKind;
  url: string;
  ai_analysis?: Record<string, any>;
  status: AssetStatus;
  created_at: string;
}

// ---------------------------------------------------------------------------
// CRM object model — Wave 1 (migration 005)
// ---------------------------------------------------------------------------
export interface Company {
  id: string;
  account_id: string;
  brand_id?: string;
  name: string;
  domain?: string;
  website?: string;
  industry?: string;
  size?: string;
  linkedin_url?: string;
  location?: string;
  description?: string;
  enriched?: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface PipelineStage {
  id: string;
  account_id: string;
  brand_id?: string;
  name: string;
  position: number;
  is_won: boolean;
  is_lost: boolean;
  created_at: string;
}

export type DealStatus = 'open' | 'won' | 'lost';

export interface Deal {
  id: string;
  account_id: string;
  brand_id?: string;
  company_id?: string;
  primary_contact_id?: string;
  stage_id?: string;
  name: string;
  amount?: number;
  currency: string;
  status: DealStatus;
  probability?: number;
  expected_close_date?: string;
  source?: string;
  owner_email?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
}

export interface DealContactRole {
  id: string;
  deal_id: string;
  contact_id: string;
  role?: string;
  created_at: string;
}

export type ActivityType = 'task' | 'call' | 'meeting' | 'email' | 'event';

export interface Activity {
  id: string;
  account_id: string;
  brand_id?: string;
  type: ActivityType;
  subject?: string;
  body?: string;
  status: 'open' | 'done';
  due_at?: string;
  completed_at?: string;
  contact_id?: string;
  company_id?: string;
  deal_id?: string;
  owner_email?: string;
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: string;
  account_id: string;
  brand_id?: string;
  body: string;
  contact_id?: string;
  company_id?: string;
  deal_id?: string;
  author_email?: string;
  created_at: string;
  updated_at: string;
}

export interface Attachment {
  id: string;
  account_id: string;
  brand_id?: string;
  filename?: string;
  url: string;
  mime_type?: string;
  size_bytes?: number;
  contact_id?: string;
  company_id?: string;
  deal_id?: string;
  created_at: string;
}

export interface CampaignMember {
  id: string;
  campaign_id: string;
  account_id: string;
  contact_id?: string;
  status: 'targeted' | 'sent' | 'responded' | 'converted';
  created_at: string;
}

export interface Territory {
  id: string;
  account_id: string;
  brand_id?: string;
  name: string;
  region?: string;
  country?: string;
  owner_email?: string;
  created_at: string;
}

export interface AuditLogEntry {
  id: string;
  account_id: string;
  brand_id?: string;
  actor_email?: string;
  action: 'import' | 'enrich' | 'merge' | 'create' | 'update' | 'delete';
  entity_type?: string;
  entity_id?: string;
  detail?: Record<string, any>;
  created_at: string;
}

export interface ContactMerge {
  id: string;
  account_id: string;
  surviving_contact_id?: string;
  merged_contact_id?: string;
  merged_snapshot?: Record<string, any>;
  reason?: string;
  actor_email?: string;
  created_at: string;
}

export interface ContactAlias {
  id: string;
  account_id: string;
  contact_id: string;
  alias_type: 'email' | 'name' | 'phone' | 'source_id';
  alias_value: string;
  source?: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// CRM object model — Wave 2 (migration 006)
// ---------------------------------------------------------------------------
export interface ContactCompanyRole {
  id: string;
  account_id: string;
  contact_id: string;
  company_id: string;
  role?: string;
  is_primary: boolean;
  created_at: string;
}
export interface Partner {
  id: string;
  account_id: string;
  brand_id?: string;
  name: string;
  type?: string;
  contact_email?: string;
  status: string;
  notes?: string;
  created_at: string;
}
export interface SupportCase {
  id: string;
  account_id: string;
  brand_id?: string;
  company_id?: string;
  contact_id?: string;
  subject: string;
  description?: string;
  status: 'open' | 'pending' | 'resolved' | 'closed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  assigned_to?: string;
  created_at: string;
  updated_at: string;
  resolved_at?: string;
}
export interface KnowledgeArticle {
  id: string;
  account_id: string;
  brand_id?: string;
  title: string;
  body?: string;
  tags?: string[];
  status: 'draft' | 'published';
  created_at: string;
  updated_at: string;
}
export interface Entitlement {
  id: string;
  account_id: string;
  company_id?: string;
  plan?: string;
  sla_tier?: string;
  seats?: number;
  starts_at?: string;
  ends_at?: string;
  created_at: string;
}
