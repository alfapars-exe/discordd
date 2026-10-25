ALTER TABLE app_logs ADD COLUMN request_id TEXT NOT NULL DEFAULT '';
ALTER TABLE app_logs ADD COLUMN event_code TEXT NOT NULL DEFAULT '';
ALTER TABLE app_logs ADD COLUMN component TEXT NOT NULL DEFAULT '';
ALTER TABLE app_logs ADD COLUMN error_kind TEXT NOT NULL DEFAULT '';
ALTER TABLE app_logs ADD COLUMN occurrence_count BIGINT NOT NULL DEFAULT 1;
ALTER TABLE app_logs ADD COLUMN last_seen_at DATETIME;
CREATE INDEX idx_app_logs_request_id ON app_logs(request_id);
CREATE INDEX idx_app_logs_component_time ON app_logs(component,created_at,id);
CREATE INDEX idx_app_logs_event_time ON app_logs(event_code,created_at,id);

ALTER TABLE runtime_telemetry ADD COLUMN diagnostics TEXT NOT NULL DEFAULT '{}';
