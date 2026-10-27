CREATE TABLE IF NOT EXISTS channel_message_notification_jobs (
    message_id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    cursor_user_id TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_batch_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_channel_message_notification_jobs_fair
    ON channel_message_notification_jobs(next_attempt_at, last_batch_at, created_at, message_id);

-- Serializable isolation and FOR SHARE protect existing rows but do not
-- prevent a concurrent INSERT from creating a new channel override. Queue
-- delivery and every ACL/membership writer therefore use the same per-server
-- advisory transaction lock. The row triggers cover direct SQL writers too.
CREATE OR REPLACE FUNCTION hichat_lock_channel_acl_server() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    server_ids TEXT[] := ARRAY[]::TEXT[];
    server_value TEXT;
BEGIN
    IF TG_TABLE_NAME = 'channel_permissions' THEN
        IF TG_OP <> 'INSERT' THEN
            SELECT server_id INTO server_value FROM channels WHERE id = OLD.channel_id;
            IF server_value IS NOT NULL THEN server_ids := array_append(server_ids, server_value); END IF;
        END IF;
        IF TG_OP <> 'DELETE' THEN
            SELECT server_id INTO server_value FROM channels WHERE id = NEW.channel_id;
            IF server_value IS NOT NULL THEN server_ids := array_append(server_ids, server_value); END IF;
        END IF;
    ELSE
        IF TG_OP <> 'INSERT' THEN server_ids := array_append(server_ids, OLD.server_id); END IF;
        IF TG_OP <> 'DELETE' THEN server_ids := array_append(server_ids, NEW.server_id); END IF;
    END IF;

    FOR server_value IN
        SELECT DISTINCT u.sid FROM unnest(server_ids) AS u(sid)
        WHERE sid IS NOT NULL ORDER BY sid
    LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(server_value, 0));
    END LOOP;

    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS channel_permissions_acl_server_fence ON channel_permissions;
CREATE TRIGGER channel_permissions_acl_server_fence
    BEFORE INSERT OR UPDATE OR DELETE ON channel_permissions
    FOR EACH ROW EXECUTE FUNCTION hichat_lock_channel_acl_server();
DROP TRIGGER IF EXISTS roles_acl_server_fence ON roles;
CREATE TRIGGER roles_acl_server_fence
    BEFORE INSERT OR UPDATE OR DELETE ON roles
    FOR EACH ROW EXECUTE FUNCTION hichat_lock_channel_acl_server();
DROP TRIGGER IF EXISTS user_roles_acl_server_fence ON user_roles;
CREATE TRIGGER user_roles_acl_server_fence
    BEFORE INSERT OR UPDATE OR DELETE ON user_roles
    FOR EACH ROW EXECUTE FUNCTION hichat_lock_channel_acl_server();
DROP TRIGGER IF EXISTS server_members_acl_server_fence ON server_members;
CREATE TRIGGER server_members_acl_server_fence
    BEFORE INSERT OR UPDATE OR DELETE ON server_members
    FOR EACH ROW EXECUTE FUNCTION hichat_lock_channel_acl_server();
DROP TRIGGER IF EXISTS channels_acl_server_fence ON channels;
CREATE TRIGGER channels_acl_server_fence
    BEFORE UPDATE OR DELETE ON channels
    FOR EACH ROW EXECUTE FUNCTION hichat_lock_channel_acl_server();

-- Preference, mute, and block writers use recipient-scoped fences. Queue
-- delivery locks actor and candidate recipient IDs in sorted order after the
-- server ACL fence, then rechecks policy in fresh READ COMMITTED statements.
CREATE OR REPLACE FUNCTION hichat_lock_channel_notification_users() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    user_ids TEXT[] := ARRAY[]::TEXT[];
    user_value TEXT;
BEGIN
    IF TG_TABLE_NAME = 'friendships' THEN
        IF TG_OP <> 'INSERT' THEN
            user_ids := array_append(user_ids, OLD.user_id);
            user_ids := array_append(user_ids, OLD.friend_id);
        END IF;
        IF TG_OP <> 'DELETE' THEN
            user_ids := array_append(user_ids, NEW.user_id);
            user_ids := array_append(user_ids, NEW.friend_id);
        END IF;
    ELSIF TG_TABLE_NAME = 'users' THEN
        IF TG_OP <> 'INSERT' THEN user_ids := array_append(user_ids, OLD.id); END IF;
        IF TG_OP <> 'DELETE' THEN user_ids := array_append(user_ids, NEW.id); END IF;
    ELSE
        IF TG_OP <> 'INSERT' THEN user_ids := array_append(user_ids, OLD.user_id); END IF;
        IF TG_OP <> 'DELETE' THEN user_ids := array_append(user_ids, NEW.user_id); END IF;
    END IF;

    FOR user_value IN
        SELECT DISTINCT u.uid FROM unnest(user_ids) AS u(uid)
        WHERE u.uid IS NOT NULL ORDER BY u.uid
    LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended('user:' || user_value, 0));
    END LOOP;

    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_preferences_notification_fence ON user_preferences;
CREATE TRIGGER user_preferences_notification_fence
    BEFORE INSERT OR UPDATE OR DELETE ON user_preferences
    FOR EACH ROW EXECUTE FUNCTION hichat_lock_channel_notification_users();
DROP TRIGGER IF EXISTS channel_mutes_notification_fence ON channel_mutes;
CREATE TRIGGER channel_mutes_notification_fence
    BEFORE INSERT OR UPDATE OR DELETE ON channel_mutes
    FOR EACH ROW EXECUTE FUNCTION hichat_lock_channel_notification_users();
DROP TRIGGER IF EXISTS server_mutes_notification_fence ON server_mutes;
CREATE TRIGGER server_mutes_notification_fence
    BEFORE INSERT OR UPDATE OR DELETE ON server_mutes
    FOR EACH ROW EXECUTE FUNCTION hichat_lock_channel_notification_users();
DROP TRIGGER IF EXISTS friendships_notification_fence ON friendships;
CREATE TRIGGER friendships_notification_fence
    BEFORE INSERT OR UPDATE OR DELETE ON friendships
    FOR EACH ROW EXECUTE FUNCTION hichat_lock_channel_notification_users();
DROP TRIGGER IF EXISTS users_notification_fence ON users;
CREATE TRIGGER users_notification_fence
    BEFORE UPDATE OF deleted_at OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION hichat_lock_channel_notification_users();
