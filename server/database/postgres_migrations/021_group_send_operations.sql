CREATE TABLE group_dm_send_operations (
 group_id TEXT NOT NULL REFERENCES group_dm_channels(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL CHECK(length(request_id) BETWEEN 16 AND 128),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 message_id TEXT NOT NULL UNIQUE,
 file_count INTEGER NOT NULL CHECK(file_count BETWEEN 0 AND 10),
 phase TEXT NOT NULL DEFAULT 'prepared' CHECK(phase IN ('prepared','committed','completed','deleted')),
 failed_indices TEXT NOT NULL DEFAULT '[]',
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(group_id,user_id,request_id)
);
