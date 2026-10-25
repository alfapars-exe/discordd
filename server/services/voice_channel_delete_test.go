package services

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

type deletionCountingLiveKitGetter struct {
	lookups atomic.Int32
	servers chan string
}

func (g *deletionCountingLiveKitGetter) GetByServerID(_ context.Context, serverID string) (*models.LiveKitInstance, error) {
	g.lookups.Add(1)
	g.servers <- serverID
	return nil, errors.New("deleted-channel test: no LiveKit instance")
}
func (*deletionCountingLiveKitGetter) IncrementMonthlyUsage(context.Context, string, int, int, int) error {
	return nil
}
func (*deletionCountingLiveKitGetter) GetMonthlyUsage(context.Context, string, int, int) (int64, error) {
	return 0, nil
}
func (*deletionCountingLiveKitGetter) GetNextAutoSwitchInstance(context.Context, string, int, int) (*models.LiveKitInstance, error) {
	return nil, nil
}
func (*deletionCountingLiveKitGetter) MigrateOneServer(context.Context, string, string) error {
	return nil
}

type deletionMusicBotHook struct{ stopped chan string }

func (h *deletionMusicBotHook) StopAllForChannel(channelID string) { h.stopped <- channelID }

func TestDeleteVoiceChannelClearsStateAndRejectsLateJoin(t *testing.T) {
	permissionEntered := make(chan struct{})
	continuePermission := make(chan struct{})
	livekitLookups := &deletionCountingLiveKitGetter{servers: make(chan string, 2)}
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.Channel, error) {
			return &models.Channel{ID: id, ServerID: "server-1", Type: models.ChannelTypeVoice}, nil
		},
	}
	permResolver := &testutil.MockChannelPermResolver{
		ResolveChannelPermissionsFn: func(context.Context, string, string) (models.Permission, error) {
			close(permissionEntered)
			<-continuePermission
			return models.PermAll, nil
		},
	}
	svc := NewVoiceService(
		channelRepo,
		livekitLookups,
		permResolver,
		&voiceTestBroadcaster{&testutil.MockBroadcaster{}},
		nil,
		&testutil.MockServerRepo{
			IsMemberFn: func(context.Context, string, string) (bool, error) { return true, nil },
			ListMemberIDsFn: func(context.Context, string) ([]string, error) {
				return []string{"joining-user"}, nil
			},
		},
		nil, nil, nil, nil,
	).(*voiceService)
	t.Cleanup(svc.ShutdownVoiceStateFanout)
	musicHook := &deletionMusicBotHook{stopped: make(chan string, 1)}
	svc.SetMusicBotHook(musicHook)
	// Include an existing occupant, viewer bookkeeping, and a room key so this
	// verifies the full in-memory cleanup path as well as the late-join fence.
	svc.states["occupant"] = &models.VoiceState{
		UserID: "occupant", ServerID: "server-1", ChannelID: "voice-1", IsStreaming: true,
		JoinedAt: time.Now().Add(-time.Minute),
	}
	svc.states["other-channel-user"] = &models.VoiceState{UserID: "other-channel-user", ServerID: "server-1", ChannelID: "voice-2"}
	svc.screenShareViewers["occupant"] = map[string]bool{"watcher": true}
	svc.screenShareViewers["unrelated-orphan"] = map[string]bool{"other-viewer": true}
	svc.offlineSince["occupant"] = time.Now().Add(-time.Minute)
	svc.roomPassphrases["server-1:voice-1"] = "secret"
	svc.roomKeyVersions["server-1:voice-1"] = 4

	joinResult := make(chan error, 1)
	go func() {
		joinResult <- svc.JoinChannel("joining-user", "joining-user", "", "", "voice-1", false, false)
	}()
	select {
	case <-permissionEntered:
	case <-time.After(time.Second):
		t.Fatal("JoinChannel did not reach permission resolution")
	}

	svc.DeleteVoiceChannel(context.Background(), "server-1", "voice-1")
	close(continuePermission)
	if err := <-joinResult; !errors.Is(err, pkg.ErrNotFound) {
		t.Fatalf("late JoinChannel error = %v, want ErrNotFound", err)
	}
	select {
	case channelID := <-musicHook.stopped:
		if channelID != "voice-1" {
			t.Fatalf("music bot stopped for %q, want voice-1", channelID)
		}
	case <-time.After(time.Second):
		t.Fatal("music bot was not stopped for the deleted voice channel")
	}
	for i := 0; i < 2; i++ {
		select {
		case serverID := <-livekitLookups.servers:
			if serverID != "server-1" {
				t.Fatalf("LiveKit eviction lookup used server %q, want server-1", serverID)
			}
		case <-time.After(time.Second):
			t.Fatalf("received %d LiveKit eviction lookups, want occupant and screen-share participant", i)
		}
	}

	svc.mu.RLock()
	defer svc.mu.RUnlock()
	if _, exists := svc.states["occupant"]; exists {
		t.Fatal("deleted channel occupant remained in voice state")
	}
	if _, exists := svc.states["joining-user"]; exists {
		t.Fatal("late join recreated deleted channel voice state")
	}
	if _, exists := svc.states["other-channel-user"]; !exists {
		t.Fatal("unrelated channel voice state was removed")
	}
	if _, exists := svc.roomPassphrases["server-1:voice-1"]; exists {
		t.Fatal("deleted channel room passphrase remained")
	}
	if _, exists := svc.roomKeyVersions["server-1:voice-1"]; exists {
		t.Fatal("deleted channel room key version remained")
	}
	if _, exists := svc.screenShareViewers["occupant"]; exists {
		t.Fatal("deleted channel screen-share viewer entry remained")
	}
	if viewers, exists := svc.screenShareViewers["unrelated-orphan"]; !exists || !viewers["other-viewer"] {
		t.Fatal("cleanup removed unrelated orphaned viewer bookkeeping")
	}
	if _, exists := svc.offlineSince["occupant"]; exists {
		t.Fatal("deleted channel occupant offline marker remained")
	}
}

func TestJoinWebhookEvictsStaleTokenForDeletedChannel(t *testing.T) {
	getter := &deletionCountingLiveKitGetter{servers: make(chan string, 2)}
	svc := NewVoiceService(
		&testutil.MockChannelRepo{GetByIDFn: func(context.Context, string) (*models.Channel, error) {
			return nil, pkg.ErrNotFound
		}},
		getter,
		&testutil.MockChannelPermResolver{},
		&voiceTestBroadcaster{&testutil.MockBroadcaster{}},
		nil, nil, nil, nil, nil, nil,
	).(*voiceService)
	t.Cleanup(svc.ShutdownVoiceStateFanout)

	// A previously-issued LiveKit JWT can outlive the DB row. On its
	// participant_joined callback, the row check must dispatch removal for
	// both the voice identity and its screen-share identity without trying to
	// resolve the deleted channel again.
	svc.EnforceModerationOnJoin(context.Background(), "server-1", "voice-1", "stale-user")
	for i := 0; i < 2; i++ {
		select {
		case serverID := <-getter.servers:
			if serverID != "server-1" {
				t.Fatalf("LiveKit eviction lookup used server %q, want server-1", serverID)
			}
		case <-time.After(time.Second):
			t.Fatalf("received %d LiveKit eviction lookups, want voice and screen-share identities", i)
		}
	}
}
