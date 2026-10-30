-- Stop the old delivery worker before applying this migration.
CREATE TABLE email_delivery_attempts (
    job_id TEXT PRIMARY KEY REFERENCES email_delivery_jobs(id) ON DELETE CASCADE,
    provider_key TEXT NOT NULL UNIQUE,
    payload TEXT NOT NULL DEFAULT '',
    first_attempt_ms BIGINT NOT NULL,
    provider_id TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL CHECK(outcome IN ('prepared','delivered','review','failed'))
);
-- Legacy attempts have no provider key: replay cannot prove non-delivery.
INSERT INTO email_delivery_attempts(job_id,provider_key,first_attempt_ms,outcome)
SELECT id,'hichat-email/'||id,0,'review' FROM email_delivery_jobs
WHERE attempts>0 AND status IN ('pending','delivering');
UPDATE email_delivery_jobs SET status='cancelled',claim_token=NULL,lease_expires_at=NULL,last_error='legacy delivery requires review'
WHERE id IN (SELECT job_id FROM email_delivery_attempts WHERE outcome='review');
