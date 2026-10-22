-- 089_cosmetics.sql - Faz G: cosmetics (frames, nameplates, name styles,
-- profile themes, profile effects). FKs are declared for local SQLite only:
-- the remote libSQL/Turso connection never enables foreign_keys, so
-- server_cascade.go, startup_repair_cosmetics.go and hardDeleteUserStmts
-- clean these rows explicitly (trap #55).
-- server_id NULL = first-party built-in item. SVG bytes are never stored:
-- built-in frames are client-bundled components keyed by asset_json.
-- Frames are svg or raster, every other type is css (structured tokens only).
CREATE TABLE IF NOT EXISTS cosmetic_items (
    id           TEXT PRIMARY KEY,
    server_id    TEXT REFERENCES servers(id) ON DELETE CASCADE,
    type         TEXT NOT NULL CHECK (type IN ('avatar_frame', 'nameplate', 'name_style', 'profile_theme', 'profile_effect')),
    format       TEXT NOT NULL CHECK (format IN ('svg', 'css', 'raster')),
    name         TEXT NOT NULL,
    description  TEXT,
    asset_json   TEXT,
    file_url     TEXT,
    animated_url TEXT,
    animated     INTEGER NOT NULL DEFAULT 0,
    availability TEXT NOT NULL DEFAULT 'free' CHECK (availability IN ('free', 'granted')),
    created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    CHECK ((format = 'raster' AND file_url IS NOT NULL AND asset_json IS NULL
            AND type = 'avatar_frame' AND server_id IS NOT NULL)
        OR (format <> 'raster' AND asset_json IS NOT NULL AND file_url IS NULL AND animated_url IS NULL)),
    CHECK (format <> 'svg' OR (server_id IS NULL AND type = 'avatar_frame')),
    CHECK ((type = 'avatar_frame' AND format <> 'css') OR (type <> 'avatar_frame' AND format = 'css')),
    CHECK (server_id IS NOT NULL OR availability = 'free')
);
CREATE INDEX IF NOT EXISTS idx_cosmetic_items_server ON cosmetic_items(server_id) WHERE server_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cosmetic_items_file_url ON cosmetic_items(file_url) WHERE file_url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cosmetic_items_animated_url ON cosmetic_items(animated_url) WHERE animated_url IS NOT NULL;

-- Grants of server-scoped 'granted' items. server_id is denormalised from
-- the item so the server cascade is a single indexed DELETE.
CREATE TABLE IF NOT EXISTS user_cosmetics (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id    TEXT NOT NULL REFERENCES cosmetic_items(id) ON DELETE CASCADE,
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    reason     TEXT NOT NULL,
    granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_user_cosmetics_item ON user_cosmetics(item_id);
CREATE INDEX IF NOT EXISTS idx_user_cosmetics_server ON user_cosmetics(server_id);

-- One slot per (user, scope, type). scope_server_id '' = global. The item's
-- canonical asset, format and animated flag are copied at equip time.
CREATE TABLE IF NOT EXISTS user_equipped (
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope_server_id TEXT NOT NULL DEFAULT '',
    type            TEXT NOT NULL CHECK (type IN ('avatar_frame', 'nameplate', 'name_style', 'profile_theme', 'profile_effect')),
    item_id         TEXT NOT NULL REFERENCES cosmetic_items(id) ON DELETE CASCADE,
    format          TEXT NOT NULL CHECK (format IN ('svg', 'css', 'raster')),
    animated        INTEGER NOT NULL DEFAULT 0,
    asset_snapshot  TEXT NOT NULL,
    equipped_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    PRIMARY KEY (user_id, scope_server_id, type)
);
CREATE INDEX IF NOT EXISTS idx_user_equipped_item ON user_equipped(item_id);
CREATE INDEX IF NOT EXISTS idx_user_equipped_scope ON user_equipped(scope_server_id) WHERE scope_server_id <> '';

CREATE TABLE IF NOT EXISTS user_cosmetic_plain_servers (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now')),
    PRIMARY KEY (user_id, server_id)
);
CREATE INDEX IF NOT EXISTS idx_user_cosmetic_plain_servers_server ON user_cosmetic_plain_servers(server_id);

-- First-party catalog (all free). asset_json is already canonical (contract field order).
INSERT OR IGNORE INTO cosmetic_items (id, server_id, type, format, name, asset_json, animated, availability, sort_order) VALUES
 ('b_frame_aurora',  NULL, 'avatar_frame', 'svg', 'Aurora',  '{"v":1,"frame":"aurora"}',  1, 'free', 10),
 ('b_frame_ember',   NULL, 'avatar_frame', 'svg', 'Kor',     '{"v":1,"frame":"ember"}',   1, 'free', 20),
 ('b_frame_frost',   NULL, 'avatar_frame', 'svg', 'Ayaz',    '{"v":1,"frame":"frost"}',   0, 'free', 30),
 ('b_frame_sakura',  NULL, 'avatar_frame', 'svg', 'Sakura',  '{"v":1,"frame":"sakura"}',  0, 'free', 40),
 ('b_frame_circuit', NULL, 'avatar_frame', 'svg', 'Devre',   '{"v":1,"frame":"circuit"}', 1, 'free', 50),
 ('b_frame_laurel',  NULL, 'avatar_frame', 'svg', 'Defne',   '{"v":1,"frame":"laurel"}',  0, 'free', 60),
 ('b_plate_dusk',     NULL, 'nameplate', 'css', 'Alacakaranlık', '{"v":1,"stops":["#2b1a4a","#6a2c70"],"angle":135,"pattern":"none"}', 0, 'free', 10),
 ('b_plate_ocean',    NULL, 'nameplate', 'css', 'Okyanus',       '{"v":1,"stops":["#0b3d5c","#1b998b"],"angle":90,"pattern":"none"}', 0, 'free', 20),
 ('b_plate_forest',   NULL, 'nameplate', 'css', 'Orman',         '{"v":1,"stops":["#1b4332","#40916c"],"angle":120,"pattern":"grain"}', 0, 'free', 30),
 ('b_plate_sunset',   NULL, 'nameplate', 'css', 'Gün batımı',    '{"v":1,"stops":["#7f2704","#d94801","#fdae6b"],"angle":90,"pattern":"none"}', 0, 'free', 40),
 ('b_plate_neon',     NULL, 'nameplate', 'css', 'Neon',          '{"v":1,"stops":["#240046","#7b2cbf","#00f5d4"],"angle":45,"pattern":"stripes"}', 0, 'free', 50),
 ('b_plate_graphite', NULL, 'nameplate', 'css', 'Grafit',        '{"v":1,"stops":["#212529","#495057"],"angle":180,"pattern":"dots"}', 0, 'free', 60),
 ('b_name_gold',     NULL, 'name_style', 'css', 'Altın',    '{"v":1,"font":"bold","stops":["#ffd166","#ffb703"],"angle":90}', 0, 'free', 10),
 ('b_name_ice',      NULL, 'name_style', 'css', 'Buz',      '{"v":1,"font":"default","stops":["#a8e6ff","#e0f7ff"],"angle":90}', 0, 'free', 20),
 ('b_name_rose',     NULL, 'name_style', 'css', 'Gül',      '{"v":1,"font":"default","stops":["#ffb3c6","#ffd6e0"],"angle":90}', 0, 'free', 30),
 ('b_name_mint',     NULL, 'name_style', 'css', 'Nane',     '{"v":1,"font":"bold","stops":["#b8f2d0","#7ee0b0"],"angle":90}', 0, 'free', 40),
 ('b_name_lilac',    NULL, 'name_style', 'css', 'Leylak',   '{"v":1,"font":"default","stops":["#d7b8ff","#b8c6ff"],"angle":90}', 0, 'free', 50),
 ('b_name_terminal', NULL, 'name_style', 'css', 'Terminal', '{"v":1,"font":"mono","stops":["#b8ffb8"],"angle":0}', 0, 'free', 60),
 ('b_theme_night',  NULL, 'profile_theme', 'css', 'Gece',        '{"v":1,"accent":"#7c5cff","gradient":["#1a1033","#3a1c71"],"angle":160}', 0, 'free', 10),
 ('b_theme_sea',    NULL, 'profile_theme', 'css', 'Deniz',       '{"v":1,"accent":"#2ec4b6","gradient":["#03263f","#0b6e79"],"angle":180}', 0, 'free', 20),
 ('b_theme_rose',   NULL, 'profile_theme', 'css', 'Gül bahçesi', '{"v":1,"accent":"#ff6b9a","gradient":["#3d0f24","#7a1f47"],"angle":150}', 0, 'free', 30),
 ('b_theme_forest', NULL, 'profile_theme', 'css', 'Orman',       '{"v":1,"accent":"#52b788","gradient":["#0b2117","#2d6a4f"],"angle":170}', 0, 'free', 40),
 ('b_theme_desert', NULL, 'profile_theme', 'css', 'Çöl',         '{"v":1,"accent":"#f4a261","gradient":["#3b1f0e","#9c4a1a"],"angle":135}', 0, 'free', 50),
 ('b_theme_steel',  NULL, 'profile_theme', 'css', 'Çelik',       '{"v":1,"accent":"#8ecae6","gradient":["#14213d","#3d5a80"],"angle":180}', 0, 'free', 60),
 ('b_effect_sparkle',  NULL, 'profile_effect', 'css', 'Işıltı',    '{"v":1,"effect":"sparkle","color":"#ffe066"}', 1, 'free', 10),
 ('b_effect_snow',     NULL, 'profile_effect', 'css', 'Kar',       '{"v":1,"effect":"snow","color":"#ffffff"}', 1, 'free', 20),
 ('b_effect_glow',     NULL, 'profile_effect', 'css', 'Hale',      '{"v":1,"effect":"glow","color":"#7c5cff"}', 1, 'free', 30),
 ('b_effect_petals',   NULL, 'profile_effect', 'css', 'Yapraklar', '{"v":1,"effect":"petals","color":"#ffb3c6"}', 1, 'free', 40),
 ('b_effect_confetti', NULL, 'profile_effect', 'css', 'Konfeti',   '{"v":1,"effect":"confetti","color":"#ffd166"}', 1, 'free', 50),
 ('b_effect_stars',    NULL, 'profile_effect', 'css', 'Yıldızlar', '{"v":1,"effect":"stars","color":"#a8e6ff"}', 1, 'free', 60);
