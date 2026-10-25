-- Existing refresh sessions must also appear in the list and be covered by
-- "end other sessions". Do not invent device metadata for legacy records.
INSERT OR IGNORE INTO auth_sessions(id,user_id,token_version,client_type,user_agent,created_at,last_active_at,expires_at)
SELECT s.id,s.user_id,s.token_version,'unknown','',
       COALESCE(CAST(strftime('%s',s.created_at) AS INTEGER),0),
       COALESCE(CAST(strftime('%s',s.created_at) AS INTEGER),0),
       COALESCE(CAST(strftime('%s',s.expires_at) AS INTEGER),0)
FROM sessions s JOIN users u ON u.id=s.user_id AND u.token_version=s.token_version
WHERE s.auth_session_id IS NULL AND s.expires_at>CURRENT_TIMESTAMP;
UPDATE sessions SET auth_session_id=id
WHERE auth_session_id IS NULL AND EXISTS(SELECT 1 FROM auth_sessions a WHERE a.id=sessions.id AND a.user_id=sessions.user_id);
