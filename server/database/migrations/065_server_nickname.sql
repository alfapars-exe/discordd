-- 065_server_nickname.sql — Per-server nickname for members.
--
-- Discord-style: a user can show up as a different display name on
-- different servers. Stored on the server_members membership row so
-- it disappears automatically when the user leaves the server.
--
-- NULL = no nickname set → clients fall back to user.display_name (or
-- user.username) as before. Empty string is never stored (server-side
-- validation strips → NULL).

ALTER TABLE server_members ADD COLUMN nickname TEXT;
