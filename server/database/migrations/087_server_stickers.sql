-- 087_server_stickers.sql — Faz D2: per-server stickers.
-- created_at is written as 'YYYY-MM-DD HH:MM:SS' UTC text (§4 #130); the repo
-- converts it to RFC3339 at the API boundary (§4 #215).
-- server_id / created_by FKs are declared for local SQLite only: the remote
-- libSQL/Turso connection never enables foreign_keys, so server_cascade.go,
-- startup_repair.go and hardDeleteUserStmts clean these rows explicitly (§4 #55).
-- cloned_from is a plain id (no FK): the source may be deleted later.
-- tags is a JSON array of strings ('[]' when none).
CREATE TABLE IF NOT EXISTS server_stickers (
    id           TEXT PRIMARY KEY,
    server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    tags         TEXT NOT NULL DEFAULT '[]',
    animated     INTEGER NOT NULL DEFAULT 0,
    file_url     TEXT NOT NULL,
    animated_url TEXT,
    copyable     INTEGER NOT NULL DEFAULT 0,
    cloned_from  TEXT,
    created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    UNIQUE (server_id, name)
);

CREATE INDEX IF NOT EXISTS idx_server_stickers_server ON server_stickers(server_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_stickers_file_url ON server_stickers(file_url);
CREATE INDEX IF NOT EXISTS idx_server_stickers_animated_url ON server_stickers(animated_url)
    WHERE animated_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_server_stickers_created_by ON server_stickers(created_by)
    WHERE created_by IS NOT NULL;
