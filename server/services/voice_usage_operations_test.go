package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/ws"
	"sync"
	"testing"
	"time"
)

func TestVoiceUsageOperationsDrainChildrenAfterAdmissionCloses(t *testing.T) {
	var group voiceOperations
	finish, ok := group.begin()
	if !ok {
		t.Fatal("first operation rejected")
	}
	stopped := make(chan struct{})
	go func() { group.closeAndWait(); close(stopped) }()
	deadline := time.Now().Add(time.Second)
	for {
		group.mu.Lock()
		closing := group.closing
		group.mu.Unlock()
		if closing {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("admission never closed")
		}
		time.Sleep(time.Millisecond)
	}
	if _, ok = group.begin(); ok {
		t.Fatal("new root admitted during shutdown")
	}
	entered, release := make(chan struct{}), make(chan struct{})
	if !group.child(func() { close(entered); <-release }) {
		t.Fatal("accepted root could not register child")
	}
	finish()
	<-entered
	select {
	case <-stopped:
		t.Fatal("shutdown returned before child completion")
	default:
	}
	close(release)
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not join child")
	}
	if group.child(func() { t.Error("late child ran") }) {
		t.Fatal("post-shutdown child accepted")
	}
	group.closeAndWait()
}

func TestVoiceUsageOperationsConcurrentShutdown(t *testing.T) {
	var group voiceOperations
	finish, ok := group.begin()
	if !ok {
		t.Fatal("operation rejected")
	}
	var callers sync.WaitGroup
	for i := 0; i < 16; i++ {
		callers.Add(1)
		go func() { defer callers.Done(); group.closeAndWait() }()
	}
	finish()
	callers.Wait()
	if _, ok = group.begin(); ok {
		t.Fatal("terminal group restarted")
	}
}

type blockingUsageRecorderGetter struct {
	mockConfigurableLiveKitGetter
	entered chan struct{}
	release chan struct{}
}

func (g *blockingUsageRecorderGetter) RecordVoiceUsage(context.Context, string, string, int, int, int) error {
	close(g.entered)
	<-g.release
	return nil
}

func TestVoiceUsageShutdownWaitsForAcceptedLeaveCredit(t *testing.T) {
	getter := &blockingUsageRecorderGetter{entered: make(chan struct{}), release: make(chan struct{})}
	var release sync.Once
	defer release.Do(func() { close(getter.release) })
	getter.GetByServerIDFn = func(context.Context, string) (*models.LiveKitInstance, error) {
		return &models.LiveKitInstance{ID: "instance", IsPlatformManaged: true}, nil
	}
	svc, hub := newTestVoiceServiceWithLiveKitGetter(getter)
	hub.BroadcastToServerFn = func(string, ws.Event) {}
	hub.BroadcastToUserFn = func(string, ws.Event) {}
	s := svc.(*voiceService)
	if err := s.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	s.states["victim"].JoinedAt = time.Now().Add(-time.Minute)
	s.mu.Unlock()
	if err := s.LeaveChannel("victim"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-getter.entered:
	case <-time.After(time.Second):
		t.Fatal("accepted leave credit did not start")
	}
	stopped := make(chan struct{})
	go func() { s.ShutdownUsageProducers(); close(stopped) }()
	deadline := time.Now().Add(time.Second)
	for {
		s.operations.mu.Lock()
		closing := s.operations.closing
		s.operations.mu.Unlock()
		if closing {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("usage admission did not close")
		}
		time.Sleep(time.Millisecond)
	}
	if err := s.JoinChannel("other", "other", "Other", "", "ch1", false, false); !errors.Is(err, context.Canceled) {
		t.Fatalf("closed service admitted join: %v", err)
	}
	select {
	case <-stopped:
		t.Fatal("shutdown returned before accepted credit finished")
	default:
	}
	release.Do(func() { close(getter.release) })
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("accepted credit was not joined")
	}
	s.ShutdownUsageProducers()
}

func TestVoiceUsageClosedAdmissionStillCleansDeletedChannel(t *testing.T) {
	svc, hub := newTestVoiceService()
	hub.BroadcastToServerFn = func(string, ws.Event) {}
	s := svc.(*voiceService)
	if err := s.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatal(err)
	}
	state := s.GetUserVoiceState("victim")
	hook := &deletionMusicBotHook{stopped: make(chan string, 1)}
	s.musicBotHook = hook
	s.ShutdownUsageProducers()
	s.DeleteVoiceChannel(context.Background(), state.ServerID, state.ChannelID)
	if s.GetUserVoiceState("victim") != nil {
		t.Fatal("closed usage admission bypassed committed channel deletion cleanup")
	}
	select {
	case channel := <-hook.stopped:
		if channel != state.ChannelID {
			t.Fatal("wrong late-deletion music channel")
		}
	default:
		t.Fatal("closed usage admission skipped synchronous music cleanup")
	}
}

func waitVoiceUsageAdmissionClosed(t *testing.T, group *voiceOperations) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		group.mu.Lock()
		closed := group.closing
		group.mu.Unlock()
		if closed {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("usage admission did not close")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestVoiceUsageShutdownWaitsForLeaveMusicCleanup(t *testing.T) {
	svc, _ := newTestVoiceService()
	s := svc.(*voiceService)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }); s.ShutdownUsageProducers() })
	s.musicBotHook = &mockMusicBotHook{StopAllForChannelFn: func(string) { close(entered); <-release }}
	s.states["victim"] = &models.VoiceState{UserID: "victim", ChannelID: "ch1", ServerID: "srv1"}
	if err := s.LeaveChannel("victim"); err != nil {
		t.Fatal(err)
	}
	assertVoiceShutdownJoins(t, s, entered, func() { once.Do(func() { close(release) }) })
}

func TestVoiceUsageShutdownWaitsForSwitchMusicCleanup(t *testing.T) {
	svc, _ := newTestVoiceService()
	s := svc.(*voiceService)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }); s.ShutdownUsageProducers() })
	s.musicBotHook = &mockMusicBotHook{StopAllForChannelFn: func(string) { close(entered); <-release }}
	s.states["victim"] = &models.VoiceState{UserID: "victim", ChannelID: "ch1", ServerID: "srv1"}
	if err := s.JoinChannel("victim", "victim", "Victim", "", "ch2", false, false); err != nil {
		t.Fatal(err)
	}
	assertVoiceShutdownJoins(t, s, entered, func() { once.Do(func() { close(release) }) })
}

func TestVoiceUsageShutdownWaitsForAdminMusicCleanup(t *testing.T) {
	svc, _ := newTestVoiceService()
	s := svc.(*voiceService)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }); s.ShutdownUsageProducers() })
	s.musicBotHook = &mockMusicBotHook{StopAllForChannelFn: func(string) { close(entered); <-release }}
	s.states["victim"] = &models.VoiceState{UserID: "victim", ChannelID: "ch1", ServerID: "srv1"}
	if err := s.AdminDisconnectUser(context.Background(), "admin", "victim"); err != nil {
		t.Fatal(err)
	}
	assertVoiceShutdownJoins(t, s, entered, func() { once.Do(func() { close(release) }) })
}

func TestVoiceUsageLateMemberRevocationOwnsDisconnectCleanup(t *testing.T) {
	svc, _ := newTestVoiceService()
	s := svc.(*voiceService)
	s.states["victim"] = &models.VoiceState{UserID: "victim", ChannelID: "ch1", ServerID: "srv1"}
	s.ShutdownUsageProducers()
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }); <-done })
	s.musicBotHook = &mockMusicBotHook{StopAllForChannelFn: func(string) { close(entered); <-release }}
	go func() { s.DisconnectServerMember("srv1", "victim"); close(done) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("late revocation dropped music cleanup")
	}
	select {
	case <-done:
		t.Fatal("late revocation escaped closed cleanup owner")
	case <-time.After(20 * time.Millisecond):
	}
	once.Do(func() { close(release) })
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("late revocation did not finish cleanup")
	}
	if s.GetUserVoiceState("victim") != nil {
		t.Fatal("late revocation retained voice state")
	}
}

func TestVoiceUsageShutdownWaitsForMoveMusicCleanup(t *testing.T) {
	svc, _ := newTestVoiceService()
	s := svc.(*voiceService)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }); s.ShutdownUsageProducers() })
	s.musicBotHook = &mockMusicBotHook{StopAllForChannelFn: func(string) { close(entered); <-release }}
	s.states["victim"] = &models.VoiceState{UserID: "victim", ChannelID: "ch1", ServerID: "srv1"}
	if err := s.MoveUser(context.Background(), "admin", "victim", "ch2"); err != nil {
		t.Fatal(err)
	}
	assertVoiceShutdownJoins(t, s, entered, func() { once.Do(func() { close(release) }) })
}

func TestVoiceUsageShutdownRejectsMoveBeforeLookup(t *testing.T) {
	s := &voiceService{}
	s.ShutdownUsageProducers()
	if err := s.MoveUser(context.Background(), "admin", "victim", "ch2"); !errors.Is(err, context.Canceled) {
		t.Fatalf("closed owner admitted move: %v", err)
	}
}

func TestVoiceUsageShutdownWaitsForAdminMute(t *testing.T) {
	svc, _ := newTestVoiceService()
	s := svc.(*voiceService)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }); s.ShutdownUsageProducers() })
	s.channelGetter = &usageBlockingChannelGetter{entered: entered, release: release}
	s.states["victim"] = &models.VoiceState{UserID: "victim", ChannelID: "ch1", ServerID: "srv1"}
	muted := true
	if err := s.AdminUpdateState(context.Background(), "admin", "victim", &muted, nil); err != nil {
		t.Fatal(err)
	}
	assertVoiceShutdownJoins(t, s, entered, func() { once.Do(func() { close(release) }) })
}

type usageBlockingChannelGetter struct {
	once             sync.Once
	entered, release chan struct{}
}

func (g *usageBlockingChannelGetter) GetByID(ctx context.Context, _ string) (*models.Channel, error) {
	g.once.Do(func() { close(g.entered) })
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-g.release:
		return nil, context.Canceled
	}
}

func TestVoiceUsageShutdownRejectsAdminStateBeforeLookup(t *testing.T) {
	s := &voiceService{}
	s.ShutdownUsageProducers()
	muted := true
	if err := s.AdminUpdateState(context.Background(), "admin", "victim", &muted, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("closed owner admitted admin state update: %v", err)
	}
}

type missingUsageChannelGetter struct{}

func (missingUsageChannelGetter) GetByID(context.Context, string) (*models.Channel, error) {
	return nil, errors.New("channel removed")
}

func TestVoiceUsageShutdownWaitsForDeletedRoomWebhook(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var enterOnce, releaseOnce sync.Once
	getter := &mockConfigurableLiveKitGetter{GetByServerIDFn: func(context.Context, string) (*models.LiveKitInstance, error) {
		enterOnce.Do(func() { close(entered) })
		<-release
		return nil, errors.New("fixture has no media server")
	}}
	svc, _ := newTestVoiceServiceWithLiveKitGetter(getter)
	s := svc.(*voiceService)
	s.channelGetter = missingUsageChannelGetter{}
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }); s.ShutdownUsageProducers() })
	s.EnforceModerationOnJoin(context.Background(), "srv1", "deleted", "victim")
	assertVoiceShutdownJoins(t, s, entered, func() { releaseOnce.Do(func() { close(release) }) })
}

func TestVoiceUsageLateDeletedRoomWebhookOwnsEviction(t *testing.T) {
	entered, release, stopped := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var enterOnce, releaseOnce sync.Once
	getter := &mockConfigurableLiveKitGetter{GetByServerIDFn: func(context.Context, string) (*models.LiveKitInstance, error) {
		enterOnce.Do(func() { close(entered) })
		<-release
		return nil, errors.New("fixture has no media server")
	}}
	svc, _ := newTestVoiceServiceWithLiveKitGetter(getter)
	s := svc.(*voiceService)
	s.channelGetter = missingUsageChannelGetter{}
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }); s.ShutdownUsageProducers() })
	s.ShutdownUsageProducers()
	go func() { s.EnforceModerationOnJoin(context.Background(), "srv1", "deleted", "victim"); close(stopped) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("deleted-room eviction not started")
	}

	select {
	case <-stopped:
		t.Fatal("late webhook escaped terminal eviction ownership")
	case <-time.After(20 * time.Millisecond):
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("webhook eviction not joined")
	}
}

type blockingUsageEntranceHook struct{ entered, release chan struct{} }

func (h blockingUsageEntranceHook) OnVoiceJoined(string, string, string) {
	close(h.entered)
	<-h.release
}

func TestVoiceUsageShutdownWaitsForEntranceHook(t *testing.T) {
	svc, _ := newTestVoiceService()
	s := svc.(*voiceService)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }); s.ShutdownUsageProducers() })
	s.SetEntranceHook(blockingUsageEntranceHook{entered: entered, release: release})
	if err := s.JoinChannel("victim", "victim", "Victim", "", "ch1", false, false); err != nil {
		t.Fatal(err)
	}
	assertVoiceShutdownJoins(t, s, entered, func() { once.Do(func() { close(release) }) })
}

func TestVoiceUsageLateMemberRevocationPreservesCredit(t *testing.T) {
	getter := &recordingUsageGetter{recorded: make(chan string, 2)}
	svc, _ := newTestVoiceServiceWithLiveKitGetter(getter)
	s := svc.(*voiceService)
	s.states["victim"] = &models.VoiceState{UserID: "victim", ChannelID: "ch1", ServerID: "srv1", UsageSessionID: "late-session", LiveKitInstanceID: "instance", LiveKitIsCloud: true, JoinedAt: time.Now().Add(-time.Minute)}
	s.ShutdownUsageProducers()
	s.DisconnectServerMember("srv1", "victim")
	select {
	case id := <-getter.recorded:
		if id != "late-session" {
			t.Fatalf("late credit lost identity: %s", id)
		}
	default:
		t.Fatal("committed late member revocation dropped usage credit")
	}
	s.DisconnectServerMember("srv1", "victim")
	select {
	case <-getter.recorded:
		t.Fatal("repeated revocation credited removed session twice")
	default:
	}
}

func assertVoiceShutdownJoins(t *testing.T, s *voiceService, entered <-chan struct{}, release func()) {
	t.Helper()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("owned work not started")
	}
	stopped := make(chan struct{})
	go func() { s.ShutdownUsageProducers(); close(stopped) }()
	select {
	case <-stopped:
		t.Fatal("shutdown returned before owned work")
	case <-time.After(20 * time.Millisecond):
	}
	release()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not join owned work")
	}
}

type blockingVoiceAccessResolver struct {
	ChannelPermResolver
	entered, release chan struct{}
}

func (r blockingVoiceAccessResolver) ResolveChannelPermissionsBulk(ctx context.Context, _ string, _ []string) (map[string]models.Permission, error) {
	close(r.entered)
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-r.release:
		return nil, context.Canceled
	}
}

func TestVoiceUsageShutdownWaitsForPermissionRecheck(t *testing.T) {
	svc, _ := newTestVoiceService()
	s := svc.(*voiceService)
	entered, release, rechecked := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }); <-rechecked; s.ShutdownUsageProducers() })
	s.states["victim"] = &models.VoiceState{UserID: "victim", ChannelID: "ch1", ServerID: "srv1"}
	s.permResolver = blockingVoiceAccessResolver{entered: entered, release: release}
	go func() { s.recheckVoiceAccess("victim", "ch1"); close(rechecked) }()
	assertVoiceShutdownJoins(t, s, entered, func() { once.Do(func() { close(release) }) })
}

func TestVoiceUsageShutdownWaitsForDeletedChannelMusic(t *testing.T) {
	svc, _ := newTestVoiceService()
	s := svc.(*voiceService)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }); s.ShutdownUsageProducers() })
	s.states["victim"] = &models.VoiceState{UserID: "victim", ChannelID: "ch1", ServerID: "srv1"}
	s.musicBotHook = &mockMusicBotHook{StopAllForChannelFn: func(string) { close(entered); <-release }}
	s.DeleteVoiceChannel(context.Background(), "srv1", "ch1")
	assertVoiceShutdownJoins(t, s, entered, func() { once.Do(func() { close(release) }) })
}
