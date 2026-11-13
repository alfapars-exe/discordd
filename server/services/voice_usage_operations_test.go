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
	var group voiceUsageOperations
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
	var group voiceUsageOperations
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
		s.usageOperations.mu.Lock()
		closing := s.usageOperations.closing
		s.usageOperations.mu.Unlock()
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

func waitVoiceUsageAdmissionClosed(t *testing.T, group *voiceUsageOperations) {
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
