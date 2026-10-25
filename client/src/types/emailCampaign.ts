export type EmailCampaignCategory = "announcements" | "tips" | "recommendations";

export type EmailCampaign = {
  id: string;
  category: EmailCampaignCategory;
  subject: string;
  body: string;
  status: "draft" | "published";
  expires_at: string;
  created_by: string;
  created_at: string;
  published_by?: string;
  published_at?: string;
  recipient_count: number;
};

export type CreateEmailCampaignRequest = {
  category: EmailCampaignCategory;
  subject: string;
  body: string;
  expires_at: string;
};

export type EmailCampaignPreview = {
  campaign: EmailCampaign;
  /** Escaped, inert HTML returned for email rendering; UI deliberately renders `campaign.body` as text. */
  body_html: string;
  eligible_recipients: number;
};
