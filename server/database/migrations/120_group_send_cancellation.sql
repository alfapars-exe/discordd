-- Preserve existing operation rows and CHECK constraints. A cancellation is
-- only permitted before message commit; it never deletes a sent message.
ALTER TABLE group_dm_send_operations ADD COLUMN cancelled_at DATETIME;
