package main

import (
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type expressionAssetDependencies struct {
	Repositories  *Repositories
	Hub           ws.Broadcaster
	Voice         services.VoiceStateGetter
	Emoji         services.EmojiService
	UploadDir     string
	MaxUploadSize int64
}
type expressionAssetServices struct {
	Soundboard services.SoundboardService
	Sticker    services.StickerService
	Clone      services.ExpressionCloneService
	Cosmetic   services.CosmeticService
}

// initExpressionAssetServices shares the existing emoji owner with cloning and
// retains the everyone-mode cosmetic entitlements and upload configuration.
func initExpressionAssetServices(deps expressionAssetDependencies) expressionAssetServices {
	repos := deps.Repositories
	soundboard := services.NewSoundboardService(repos.Soundboard, repos.User, deps.Hub, deps.Voice, deps.UploadDir, deps.MaxUploadSize)
	sticker := services.NewStickerService(repos.Sticker, deps.Hub, deps.UploadDir)
	clone := services.NewExpressionCloneService(repos.Emoji, deps.Emoji, repos.Sticker, sticker, repos.Server, deps.UploadDir)
	cosmetic := services.NewCosmeticService(repos.Cosmetic, repos.Server, services.NewEveryoneCosmeticEntitlements(repos.Cosmetic, repos.Server), deps.Hub)
	return expressionAssetServices{Soundboard: soundboard, Sticker: sticker, Clone: clone, Cosmetic: cosmetic}
}
