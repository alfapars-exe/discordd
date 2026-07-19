-- Tracks when a user was last online, stamped at the offline transition
-- (ws disconnect handler / manual invisible / stale-presence reset on boot).
-- NULL = never recorded yet (pre-existing users until their next session).
-- Consumed by the member list to show "last seen X ago" under offline names.
ALTER TABLE users ADD COLUMN last_seen_at DATETIME;
