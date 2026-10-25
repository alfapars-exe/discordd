-- Older friend-request emails included sender profile data and had no event
-- context for delivery-time validation. Retain their audit rows, but prevent
-- pending or leased legacy jobs from being sent after this upgrade.
UPDATE email_delivery_jobs
SET status='cancelled',last_error='legacy friendship email retired',claim_token=NULL,lease_expires_at=NULL
WHERE category='social'
  AND (dedupe_key LIKE 'friend-request:%' OR dedupe_key LIKE 'friend-accepted:%')
  AND friendship_id IS NULL
  AND status IN ('pending','delivering');
