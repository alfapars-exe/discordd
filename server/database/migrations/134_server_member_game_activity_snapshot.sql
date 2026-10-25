ALTER TABLE server_members
ADD COLUMN game_activity_audience INTEGER
CHECK (game_activity_audience IS NULL OR game_activity_audience IN (0, 1));
