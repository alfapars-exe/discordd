-- Bind moderation reports to an authorized conversation message without
-- requiring the server to decrypt E2EE payloads. evidence_content is only
-- populated when the reporting client explicitly opts to disclose it.
ALTER TABLE reports ADD COLUMN source_kind TEXT;
ALTER TABLE reports ADD COLUMN source_server_id TEXT;
ALTER TABLE reports ADD COLUMN source_channel_id TEXT;
ALTER TABLE reports ADD COLUMN source_message_id TEXT;
ALTER TABLE reports ADD COLUMN evidence_content TEXT;
ALTER TABLE reports ADD COLUMN evidence_shared INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_reports_source_message
ON reports(reporter_id, source_message_id, status)
WHERE source_message_id IS NOT NULL;
