/**
 * LiveKit admin types — instance management, quota tracking, and
 * Prometheus metrics (parsed server-side, exposed to admin UI).
 */

/** LiveKit instance info for admin panel (credentials stay on backend). */
export type LiveKitInstanceAdmin = {
  id: string;
  url: string;
  is_platform_managed: boolean;
  server_count: number;
  max_servers: number;
  hetzner_server_id: string;
  created_at: string;
  // Quota fields. Cloud instances (is_platform_managed=true) honour these;
  // self-hosted (false) ignore them — UI renders an "♾️ Sınırsız" badge.
  priority: number;
  monthly_quota_minutes: number;
  quota_reset_day: number;
  auto_switch_enabled: boolean;
  switch_threshold_minutes: number;
};

/** Quota panel row — admin view + current-month usage + computed fields. */
export type LiveKitInstanceQuotaView = LiveKitInstanceAdmin & {
  used_minutes: number;
  remaining_minutes: number;
  days_until_reset: number;
};

export type CreateLiveKitInstanceRequest = {
  url: string;
  api_key: string;
  api_secret: string;
  max_servers: number;
  hetzner_server_id?: string;
  is_platform_managed?: boolean; // omit = LiveKit Cloud; false = self-hosted
};

export type UpdateLiveKitInstanceRequest = {
  url?: string;
  api_key?: string;
  api_secret?: string;
  max_servers?: number;
  hetzner_server_id?: string;
  is_platform_managed?: boolean;
};

export type UpdateLiveKitQuotaSettingsRequest = {
  priority?: number;
  monthly_quota_minutes?: number;
  quota_reset_day?: number;
  auto_switch_enabled?: boolean;
  switch_threshold_minutes?: number;
};

/** Parsed Prometheus metrics from LiveKit instance. */
export type LiveKitInstanceMetrics = {
  goroutines: number;
  memory_used: number;
  room_count: number;
  participant_count: number;
  track_publish_count: number;
  track_subscribe_count: number;
  bytes_in: number;
  bytes_out: number;
  packets_in: number;
  packets_out: number;
  nack_total: number;
  cpu_pct: number;
  bw_in_bps: number;
  bw_out_bps: number;
  hetzner_avail: boolean;
  screen_share_count: number;
  screen_share_viewers: number;
  fetched_at: string;
  available: boolean;
};

/** Aggregated historical metrics for a time period (SQL aggregate). */
export type MetricsHistorySummary = {
  period: string;
  sample_count: number;
  peak_participants: number;
  avg_participants: number;
  peak_rooms: number;
  avg_rooms: number;
  peak_memory_bytes: number;
  avg_memory_bytes: number;
  peak_cpu_pct: number;
  avg_cpu_pct: number;
  peak_bandwidth_in_bps: number;
  avg_bandwidth_in_bps: number;
  peak_bandwidth_out_bps: number;
  avg_bandwidth_out_bps: number;
  peak_goroutines: number;
  avg_goroutines: number;
};

/** Single time-series data point for charts. */
export type MetricsTimeSeriesPoint = {
  ts: string;
  cpu_pct: number;
  bw_in: number;
  bw_out: number;
  participants: number;
  memory_bytes: number;
  screen_shares: number;
};
