ALTER TABLE data_exports ADD COLUMN attachment_status TEXT NOT NULL DEFAULT 'not_configured'
    CHECK (attachment_status IN ('none','not_configured','pending','building','ready','failed'));
ALTER TABLE data_exports ADD COLUMN attachment_error TEXT;
ALTER TABLE data_exports ADD COLUMN attachment_payload TEXT;

CREATE TABLE IF NOT EXISTS data_export_archive_budget (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    reserved_bytes BIGINT NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0)
);
INSERT INTO data_export_archive_budget(id, reserved_bytes) VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS data_export_archive_reservations (
    job_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    reserved_bytes BIGINT NOT NULL CHECK (reserved_bytes > 0),
    state TEXT NOT NULL CHECK (state IN ('building','ready','abandoned')),
    expires_at TIMESTAMPTZ NOT NULL,
    lease_owner TEXT,
    lease_until TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_data_export_archive_building_owner
    ON data_export_archive_reservations(user_id) WHERE state='building';
CREATE INDEX IF NOT EXISTS idx_data_export_archive_reservations_expiry
    ON data_export_archive_reservations(expires_at);
