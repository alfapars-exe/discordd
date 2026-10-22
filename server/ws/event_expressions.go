package ws

// Server custom emoji operations, broadcast with BroadcastToServer to the
// emoji's server. create/update carry the full models.ServerEmoji; delete
// carries {"id", "server_id"}. Deliberately NOT in BotReadableOps: bots have
// no use for them.
const (
	OpServerEmojiCreate = "server_emoji_create"
	OpServerEmojiUpdate = "server_emoji_update"
	OpServerEmojiDelete = "server_emoji_delete"
)

// Server sticker operations, same shape as the emoji ones: create/update
// carry the full models.ServerSticker, delete carries {"id", "server_id"}.
// Not in BotReadableOps either.
const (
	OpServerStickerCreate = "server_sticker_create"
	OpServerStickerUpdate = "server_sticker_update"
	OpServerStickerDelete = "server_sticker_delete"
)
