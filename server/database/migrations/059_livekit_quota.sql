-- 059_livekit_quota.sql
--
-- Per-instance LiveKit Cloud quota tracking + automatic instance switching
-- when the active instance approaches its monthly minute budget.
--
-- Schema:
--
--   livekit_instances grows five columns:
--
--     priority                 — auto-switch ordering (lower = preferred).
--     monthly_quota_minutes    — billing-cycle ceiling (default 5000 for
--                                LiveKit Cloud free tier).
--     quota_reset_day          — day-of-month the cycle resets (default 1).
--     auto_switch_enabled      — whether this instance participates in the
--                                "remaining < threshold → migrate to next"
--                                rotation. Self-hosted (is_platform_managed=0)
--                                instances should be set to 0 by the UI.
--     switch_threshold_minutes — when remaining minutes drop below this,
--                                the next eligible instance takes over for
--                                new voice tokens (default 20).
--
--   livekit_monthly_usage stores accumulated voice-session seconds per
--   (instance, year, month). Voice service writes here on session end —
--   only for is_platform_managed=1 instances. Self-hosted sessions never
--   touch this table.

ALTER TABLE livekit_instances ADD COLUMN priority INTEGER NOT NULL DEFAULT 100;
ALTER TABLE livekit_instances ADD COLUMN monthly_quota_minutes INTEGER NOT NULL DEFAULT 5000;
ALTER TABLE livekit_instances ADD COLUMN quota_reset_day INTEGER NOT NULL DEFAULT 1;
ALTER TABLE livekit_instances ADD COLUMN auto_switch_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE livekit_instances ADD COLUMN switch_threshold_minutes INTEGER NOT NULL DEFAULT 20;

CREATE TABLE IF NOT EXISTS livekit_monthly_usage (
    instance_id  TEXT    NOT NULL,
    year         INTEGER NOT NULL,
    month        INTEGER NOT NULL,
    used_seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (instance_id, year, month),
    FOREIGN KEY (instance_id) REFERENCES livekit_instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_lk_usage_year_month
    ON livekit_monthly_usage(year, month);
