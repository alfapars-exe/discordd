UPDATE email_delivery_jobs
SET status='cancelled',last_error='legacy friendship email retired',claim_token=NULL,lease_expires_at=NULL
WHERE category='social'
  AND (dedupe_key LIKE 'friend-request:%' OR dedupe_key LIKE 'friend-accepted:%')
  AND friendship_id IS NULL
  AND status IN ('pending','delivering');
