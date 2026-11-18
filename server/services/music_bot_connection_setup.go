package services

import (
	"fmt"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/livekit/protocol/auth"
	lksdk "github.com/livekit/server-sdk-go/v2"
	e2eetypes "github.com/livekit/server-sdk-go/v2/e2ee/types"
)

// prepareMusicFrameEncryptor validates the room key before any instance lookup.
func (s *musicBotService) prepareMusicFrameEncryptor(roomName string) (e2eetypes.FrameEncryptor, error) {
	if s.roomKeys == nil {
		return nil, fmt.Errorf("music room E2EE key source is unavailable")
	}
	keyProvider := &musicRoomKeyProvider{source: s.roomKeys, roomName: roomName}
	keyIndex := keyProvider.CurrentKeyIndex()
	if _, err := keyProvider.GetKey(keyIndex); err != nil {
		return nil, fmt.Errorf("prepare music room E2EE key: %w", err)
	}
	frameEncryptor, err := lksdk.NewFrameEncryptor(keyProvider, lksdk.CodecOpus)
	if err != nil {
		return nil, fmt.Errorf("prepare music Opus frame encryption: %w", err)
	}
	return frameEncryptor, nil
}

// musicBotRoomToken decrypts operator credentials and signs the original bot grants.
func (s *musicBotService) musicBotRoomToken(bot *botInstance, lkInstance *models.LiveKitInstance) (string, error) {
	apiKey, err := crypto.Decrypt(lkInstance.APIKey, s.encryptionKey)
	if err != nil {
		musicBotLogger.Error("connectBotToRoom: api key decrypt failed", "instance_id", lkInstance.ID, "err", pkg.ErrText(err))
		return "", fmt.Errorf("api key decrypt: %w", err)
	}
	apiSecret, err := crypto.Decrypt(lkInstance.APISecret, s.encryptionKey)
	if err != nil {
		musicBotLogger.Error("connectBotToRoom: api secret decrypt failed", "instance_id", lkInstance.ID, "err", pkg.ErrText(err))
		return "", fmt.Errorf("api secret decrypt: %w", err)
	}

	canPublish := true
	canSubscribe := true
	canPublishData := false

	at := auth.NewAccessToken(apiKey, apiSecret)
	at.SetVideoGrant(&auth.VideoGrant{
		RoomJoin:       true,
		Room:           bot.roomName,
		CanPublish:     &canPublish,
		CanSubscribe:   &canSubscribe,
		CanPublishData: &canPublishData,
	}).
		SetIdentity(models.MusicBotUserID + ":" + bot.channelID).
		SetName("MusicBot").
		SetValidFor(24 * time.Hour)

	token, err := at.ToJWT()
	if err != nil {
		return "", fmt.Errorf("jwt: %w", err)
	}

	return token, nil
}
