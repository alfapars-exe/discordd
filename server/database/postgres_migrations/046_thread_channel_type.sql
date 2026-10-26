-- Widen the existing constraint in place: no table rebuild or FK changes.
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check
    CHECK (type IN ('text', 'voice', 'audit', 'thread'));
