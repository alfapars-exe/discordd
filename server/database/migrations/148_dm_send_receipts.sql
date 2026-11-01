CREATE TABLE dm_send_receipts (
 dm_channel_id TEXT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 message_id TEXT NOT NULL,
 PRIMARY KEY(dm_channel_id,user_id,request_id)
);
