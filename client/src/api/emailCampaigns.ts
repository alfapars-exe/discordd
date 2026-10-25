import { apiClient, getAuthGeneration } from "./client";
import type { CreateEmailCampaignRequest, EmailCampaign, EmailCampaignPreview } from "../types/emailCampaign";

export type EmailCampaignRequestContext = { isCurrent?: () => boolean; signal?: AbortSignal };

function requestOptions(context: EmailCampaignRequestContext) {
  const generation = getAuthGeneration();
  return {
    timeoutMs: 15_000,
    signal: context.signal,
    isCurrent: () => generation === getAuthGeneration() && (!context.isCurrent || context.isCurrent()),
  };
}

export function createEmailCampaignDraft(request: CreateEmailCampaignRequest, context: EmailCampaignRequestContext = {}) {
  return apiClient<EmailCampaign>("/admin/email-campaigns", {
    ...requestOptions(context), method: "POST", body: request,
  });
}

export function getEmailCampaignPreview(id: string, context: EmailCampaignRequestContext = {}) {
  return apiClient<EmailCampaignPreview>(`/admin/email-campaigns/${encodeURIComponent(id)}`, requestOptions(context));
}

export function publishEmailCampaign(id: string, context: EmailCampaignRequestContext = {}) {
  return apiClient<EmailCampaign>(`/admin/email-campaigns/${encodeURIComponent(id)}/publish`, {
    ...requestOptions(context), method: "POST",
  });
}
