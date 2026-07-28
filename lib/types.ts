export type Segment = 'investor' | 'vc' | 'angel' | 'founder' | 'media' | 'partner' | 'other';
export const SEGMENTS: Segment[] = ['investor', 'vc', 'angel', 'founder', 'media', 'partner', 'other'];

export type ContactStatus = 'new' | 'contacted' | 'engaged';
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
  title?: string;
  segment: Segment;
  score: number;
  status: ContactStatus;
  notes?: string;
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
