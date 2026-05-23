/**
 * Feedback ticket types — bug reports / suggestions raised by users
 * and inboxed by platform admins.
 */

export type FeedbackType = "bug" | "suggestion" | "question" | "other";
export type FeedbackStatus = "open" | "in_progress" | "resolved" | "closed";

export type FeedbackAttachment = {
  id: string;
  ticket_id: string;
  reply_id?: string | null;
  filename: string;
  file_url: string;
  file_size?: number | null;
  mime_type?: string | null;
};

export type FeedbackTicket = {
  id: string;
  user_id: string;
  type: FeedbackType;
  subject: string;
  content: string;
  status: FeedbackStatus;
  created_at: string;
  updated_at: string;
  username?: string;
  display_name?: string | null;
  reply_count?: number;
  attachments?: FeedbackAttachment[];
};

export type FeedbackReply = {
  id: string;
  ticket_id: string;
  user_id: string;
  is_admin: boolean;
  content: string;
  created_at: string;
  username?: string;
  display_name?: string | null;
  attachments?: FeedbackAttachment[];
};
