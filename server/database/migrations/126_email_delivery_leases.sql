ALTER TABLE email_delivery_jobs ADD COLUMN claim_token TEXT;
ALTER TABLE email_delivery_jobs ADD COLUMN lease_expires_at DATETIME;

-- Legacy rows in delivering had no recoverable ownership token. Make them
-- immediately reclaimable; ClaimDue applies the bounded-attempt policy.
UPDATE email_delivery_jobs
SET claim_token=NULL, lease_expires_at=NULL
WHERE status='delivering';

CREATE INDEX IF NOT EXISTS idx_email_delivery_lease
ON email_delivery_jobs(status,lease_expires_at,id);
