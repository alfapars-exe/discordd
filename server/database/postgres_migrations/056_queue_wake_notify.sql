-- Wake the in-process queue workers when durable work becomes ready, so they
-- can idle instead of polling the database several times per second.
-- pg_notify is delivered on commit and identical payloads within one
-- transaction are coalesced. Polling remains as a bounded safety net.
CREATE FUNCTION hichat_queue_wake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('hichat_queue_wake', TG_TABLE_NAME);
 RETURN NULL;
END $$;
CREATE TRIGGER channel_delivery_outbox_wake AFTER INSERT OR UPDATE OF ready ON channel_delivery_outbox
 FOR EACH ROW WHEN (NEW.ready AND NEW.published_at IS NULL) EXECUTE FUNCTION hichat_queue_wake();
CREATE TRIGGER dm_delivery_outbox_wake AFTER INSERT OR UPDATE OF ready ON dm_delivery_outbox
 FOR EACH ROW WHEN (NEW.ready AND NEW.published_at IS NULL) EXECUTE FUNCTION hichat_queue_wake();
CREATE TRIGGER channel_message_notification_jobs_wake AFTER INSERT ON channel_message_notification_jobs
 FOR EACH ROW EXECUTE FUNCTION hichat_queue_wake();
