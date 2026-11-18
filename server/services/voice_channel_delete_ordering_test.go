package services

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
)

func TestDeleteVoiceChannelHandsOffAllCreditsBeforeMedia(t *testing.T) {
	for _, scenario := range []struct {
		name          string
		closed, music bool
		workers       int
	}{
		{name: "admitted-eviction", workers: 4},
		{name: "closed-eviction", closed: true, workers: 1},
		{name: "closed-music", closed: true, music: true, workers: 1},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			getter := &recordingUsageGetter{recorded: make(chan string, 8)}
			entered, release := make(chan struct{}, 32), make(chan struct{})
			getter.GetByServerIDFn = func(context.Context, string) (*models.LiveKitInstance, error) {
				entered <- struct{}{}
				<-release
				return nil, errors.New("fixture media unavailable")
			}
			svc, _ := newTestVoiceServiceWithLiveKitGetter(getter, getter.RecordVoiceUsage)
			s := svc.(*voiceService)
			for i := 0; i < 8; i++ {
				id := fmt.Sprint(i)
				s.states[id] = &models.VoiceState{UserID: id, ServerID: "server", ChannelID: "channel", UsageSessionID: "credit-" + id, LiveKitInstanceID: "instance", LiveKitIsCloud: true, JoinedAt: time.Now().Add(-time.Minute)}
			}
			if scenario.music {
				s.musicBotHook = &mockMusicBotHook{StopAllForChannelFn: func(string) { entered <- struct{}{}; <-release }}
			}
			if scenario.closed {
				s.ShutdownUsageProducers()
			}
			done := make(chan struct{})
			var once sync.Once
			t.Cleanup(func() { once.Do(func() { close(release) }); <-done; s.ShutdownUsageProducers() })
			go func() { s.DeleteVoiceChannel(context.Background(), "server", "channel"); close(done) }()
			for i := 0; i < scenario.workers; i++ {
				select {
				case <-entered:
				case <-time.After(time.Second):
					t.Fatal("media cleanup did not reach blocking fixture")
				}
			}
			if got := len(getter.recorded); got != 8 {
				t.Fatalf("media cleanup began before all credit handoffs: got=%d want=8", got)
			}
			if len(s.GetAllVoiceStates()) != 0 {
				t.Fatal("deleted channel retained active state")
			}
			once.Do(func() { close(release) })
		})
	}
}

// A held recorder makes the worker bound observable without network timing.
type blockedDeletionCreditGetter struct {
	mockConfigurableLiveKitGetter
	entered chan string
	release <-chan struct{}
}

func (g *blockedDeletionCreditGetter) RecordVoiceUsage(_ context.Context, id, _ string, _, _, _ int) error {
	g.entered <- id
	<-g.release
	return nil
}

func TestDeleteVoiceChannelBoundsAndJoinsCreditPhase(t *testing.T) {
	release := make(chan struct{})
	getter := &blockedDeletionCreditGetter{entered: make(chan string, 8), release: release}
	media := make(chan struct{}, 17)
	getter.GetByServerIDFn = func(context.Context, string) (*models.LiveKitInstance, error) {
		media <- struct{}{}
		return nil, errors.New("fixture media unavailable")
	}
	svc, _ := newTestVoiceServiceWithLiveKitGetter(getter, getter.RecordVoiceUsage)
	s := svc.(*voiceService)
	s.musicBotHook = &mockMusicBotHook{StopAllForChannelFn: func(string) { media <- struct{}{} }}
	for i := 0; i < 8; i++ {
		id := fmt.Sprint(i)
		s.states[id] = &models.VoiceState{UserID: id, ServerID: "server", ChannelID: "channel", UsageSessionID: "credit-" + id, LiveKitInstanceID: "instance", LiveKitIsCloud: true, JoinedAt: time.Now().Add(-time.Minute)}
	}
	s.DeleteVoiceChannel(context.Background(), "server", "channel")
	done := make(chan struct{})
	go func() { s.ShutdownUsageProducers(); close(done) }()
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }); <-done })
	for i := 0; i < 4; i++ {
		select {
		case <-getter.entered:
		case <-time.After(time.Second):
			t.Fatal("four accounting workers did not start")
		}
	}
	select {
	case <-getter.entered:
		t.Fatal("fifth accounting worker started while four blocked")
	case <-time.After(20 * time.Millisecond):
	}
	if len(media) != 0 {
		t.Fatal("media began before accounting phase joined")
	}
	select {
	case <-done:
		t.Fatal("producer shutdown did not join accounting phase")
	default:
	}
	once.Do(func() { close(release) })
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("accounting or media phase did not drain")
	}
	if len(getter.entered) != 4 || len(media) != 17 {
		t.Fatalf("incomplete cleanup: remaining credits=%d media=%d", len(getter.entered), len(media))
	}
}
