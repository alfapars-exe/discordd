//go:build livekit_integration

package services

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/testutil"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

func TestVoluntaryLeaveEvictsLiveKitParticipants(t *testing.T) {
	endpoint, key, secret := os.Getenv("HICHAT_TEST_LIVEKIT_URL"), os.Getenv("HICHAT_TEST_LIVEKIT_KEY"), os.Getenv("HICHAT_TEST_LIVEKIT_SECRET")
	if endpoint == "" || key == "" || secret == "" {
		t.Fatal("set the dedicated LiveKit fixture URL, key and secret")
	}
	channelID := "leave-" + time.Now().UTC().Format("150405.000000000")
	voice, _ := newTestVoiceServiceWithChannelRepo(&testutil.MockChannelRepo{GetByIDFn: func(context.Context, string) (*models.Channel, error) {
		return &models.Channel{ID: channelID, ServerID: joinTestServerID, Type: models.ChannelTypeVoice}, nil
	}})
	encrypt := func(value string) string {
		t.Helper()
		encrypted, err := crypto.Encrypt(value, tokenTestEncryptionKey)
		if err != nil {
			t.Fatal(err)
		}
		return encrypted
	}
	instance := &models.LiveKitInstance{URL: endpoint, APIKey: encrypt(key), APISecret: encrypt(secret)}
	v := voice.(*voiceService)
	v.encryptionKey = tokenTestEncryptionKey
	v.livekitGetter = &mockConfigurableLiveKitGetter{GetByServerIDFn: func(context.Context, string) (*models.LiveKitInstance, error) { return instance, nil }}
	h := newJoinServerHarness(v.DisconnectServerMember)
	if err := voice.JoinChannel(joinTestUserID, "reader", "Reader", "", channelID, false, false); err != nil {
		t.Fatal(err)
	}
	forReason := make(map[string]chan lksdk.DisconnectionReason)
	for _, id := range []string{joinTestUserID, joinTestUserID + "_ss", "observer"} {
		reasons := make(chan lksdk.DisconnectionReason, 1)
		room, err := lksdk.ConnectToRoom(endpoint, lksdk.ConnectInfo{APIKey: key, APISecret: secret, RoomName: joinTestServerID + ":" + channelID, ParticipantIdentity: id}, &lksdk.RoomCallback{OnDisconnectedWithReason: func(r lksdk.DisconnectionReason) {
			select {
			case reasons <- r:
			default:
			}
		}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(room.Disconnect)
		forReason[id] = reasons
	}
	if err := h.svc.LeaveServer(context.Background(), joinTestServerID, joinTestUserID); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{joinTestUserID, joinTestUserID + "_ss"} {
		select {
		case reason := <-forReason[id]:
			if reason != lksdk.ParticipantRemoved {
				t.Fatalf("%s disconnected: %s", id, reason)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("%s stayed connected", id)
		}
	}
	select {
	case reason := <-forReason["observer"]:
		t.Fatalf("observer disconnected: %s", reason)
	default:
	}
}
