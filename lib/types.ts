export type Segment = 'investor' | 'vc' | 'angel' | 'founder' | 'media' | 'partner' | 'other';
export type EmailStatus = 'draft' | 'sent' | 'opened' | 'replied' | 'bounced';
export type ContentStatus = 'draft' | 'pending_approval' | 'approved' | 'scheduled' | 'published' | 'failed';
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
  status: 'new' | 'contacted' | 'engaged';
  notes?: string;
  created_at: string;
}

export interface EmailCampaign {
  id: string;
  brand_id: string;
  contact_id: string;
  subject: string;
  body_html: string;
  status: EmailStatus;
  brevo_id?: string;
  sent_at?: string;
  created_at: string;
}

export interface ContentPost {
  id: string;
  brand_id: string;
  platform: Platform;
  copy: string;
  media_url?: string;
  scheduled_at: string;
  status: ContentStatus;
  postiz_id?: string;
  created_at: string;
}

export interface AdCampaign {
  id: string;
  brand_id: string;
  name: string;
  budget: number;
  start_date: string;
  end_date: string;
  created_at: string;
}