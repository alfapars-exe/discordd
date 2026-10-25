import { apiClient } from "./client";

export type PersonalizationRecommendations = {
  enabled: boolean;
  items: Array<"complete_profile" | "join_server" | "add_friend">;
};

export function getRecommendations() {
  return apiClient<PersonalizationRecommendations>("/users/me/recommendations");
}
