package main

import "github.com/argeinfina/hichat/models"

// registerExpressionRoutes wires the per-server custom emoji and sticker
// endpoints. Listing a server's emojis/stickers is membership-gated
// (authServer); every write needs PermManageExpressions. GET
// /api/users/me/{emojis,stickers} returns those of every server the caller
// is a member of — scoped by the server_members join inside the
// repository, so plain auth is the gate. The clone routes are gated by
// PermManageExpressions in the TARGET server ({serverId}); membership of
// the source server is checked inside ExpressionCloneService.
func (d *routeDeps) registerExpressionRoutes() {
	d.mux.Handle("GET /api/servers/{serverId}/emojis", d.authServer(d.h.Emoji.List))
	d.mux.Handle("POST /api/servers/{serverId}/emojis", d.authServerPerm(models.PermManageExpressions, d.h.Emoji.Create))
	d.mux.Handle("PATCH /api/servers/{serverId}/emojis/{emojiId}", d.authServerPerm(models.PermManageExpressions, d.h.Emoji.Update))
	d.mux.Handle("DELETE /api/servers/{serverId}/emojis/{emojiId}", d.authServerPerm(models.PermManageExpressions, d.h.Emoji.Delete))
	d.mux.Handle("GET /api/users/me/emojis", d.auth(d.h.Emoji.ListMine))

	d.mux.Handle("GET /api/servers/{serverId}/stickers", d.authServer(d.h.Sticker.List))
	d.mux.Handle("POST /api/servers/{serverId}/stickers", d.authServerPerm(models.PermManageExpressions, d.h.Sticker.Create))
	d.mux.Handle("PATCH /api/servers/{serverId}/stickers/{stickerId}", d.authServerPerm(models.PermManageExpressions, d.h.Sticker.Update))
	d.mux.Handle("DELETE /api/servers/{serverId}/stickers/{stickerId}", d.authServerPerm(models.PermManageExpressions, d.h.Sticker.Delete))
	d.mux.Handle("GET /api/users/me/stickers", d.auth(d.h.Sticker.ListMine))

	d.mux.Handle("POST /api/servers/{serverId}/emojis/clone", d.authServerPerm(models.PermManageExpressions, d.h.ExpressionClone.CloneEmoji))
	d.mux.Handle("POST /api/servers/{serverId}/stickers/clone", d.authServerPerm(models.PermManageExpressions, d.h.ExpressionClone.CloneSticker))
}
