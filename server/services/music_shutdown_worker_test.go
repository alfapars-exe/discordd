package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"sync"
	"testing"
	"time"
)

func TestMusicStopAllJoinsAcceptedPlaybackWorker(t *testing.T) {
	for _, removed := range []bool{false, true} {
		name := "active"
		if removed {
			name = "removed"
		}
		t.Run(name, func(t *testing.T) { checkMusicPlaybackShutdown(t, removed) })
	}
}

func checkMusicPlaybackShutdown(t *testing.T, removed bool) {
	t.Helper()
	entered, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	svc := newConcurrencyTestService(t, &eventLog{}, func(*botInstance, *models.MusicTrack) error {
		close(entered)
		<-release
		close(finished)
		return nil
	})
	var once sync.Once
	t.Cleanup(func() {
		once.Do(func() { close(release) })
		svc.StopAll()
		select {
		case <-finished:
		case <-time.After(2 * time.Second):
			t.Error("playback did not finish")
		}
	})
	if _, err := svc.Enqueue(context.Background(), "actor", concTestChannel, concTestURL); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("playback did not start")
	}
	if removed {
		svc.StopAllForChannel(concTestChannel)
	}
	stopped := make(chan struct{})
	go func() { svc.StopAll(); close(stopped) }()
	select {
	case <-stopped:
		t.Fatal("StopAll returned while accepted playback worker was running")
	case <-time.After(25 * time.Millisecond):
	}
	second := make(chan struct{})
	go func() { svc.StopAll(); close(second) }()
	once.Do(func() { close(release) })
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("StopAll did not join playback")
	}
	select {
	case <-second:
	case <-time.After(2 * time.Second):
		t.Fatal("concurrent StopAll did not join")
	}
	if _, err := svc.Enqueue(context.Background(), "late", concTestChannel, concTestURL); !errors.Is(err, context.Canceled) {
		t.Fatalf("late enqueue: %v", err)
	}
	if err := svc.Restore(context.Background(), concTestChannel); !errors.Is(err, context.Canceled) {
		t.Fatalf("late restore: %v", err)
	}

}

func TestMusicStopAllCancelsAndJoinsProducer(t *testing.T) {
	for _, stage := range []string{"extraction", "connection"} {
		t.Run(stage, func(t *testing.T) { checkMusicProducerShutdown(t, stage) })
	}
}

func checkMusicProducerShutdown(t *testing.T, stage string) {
	t.Helper()
	entered, canceled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	svc := newConcurrencyTestService(t, &eventLog{}, func(*botInstance, *models.MusicTrack) error { return nil })
	block := func(ctx context.Context) error {
		close(entered)
		<-ctx.Done()
		close(canceled)
		<-release
		return ctx.Err()
	}
	if stage == "extraction" {
		svc.extractTracksFn = func(ctx context.Context, _, _, _ string) ([]models.MusicTrack, error) { return nil, block(ctx) }
	} else {
		svc.connectBotFn = func(ctx context.Context, _ *botInstance) error { return block(ctx) }
	}
	var once sync.Once
	t.Cleanup(func() { once.Do(func() { close(release) }); svc.StopAll() })
	result := make(chan error, 1)
	go func() {
		_, err := svc.Enqueue(context.Background(), "actor", concTestChannel, concTestURL)
		result <- err
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("producer did not start")
	}
	stopped := make(chan struct{})
	go func() { svc.StopAll(); close(stopped) }()
	select {
	case <-canceled:
	case <-time.After(2 * time.Second):
		t.Fatal("producer cancellation missing")
	}
	select {
	case <-stopped:
		t.Fatal("StopAll escaped accepted producer")
	case <-time.After(25 * time.Millisecond):
	}
	once.Do(func() { close(release) })
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("producer did not join")
	}
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("canceled producer reported success")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("enqueue did not return")
	}
	svc.mu.RLock()
	remaining := len(svc.bots)
	svc.mu.RUnlock()
	if remaining != 0 {
		t.Fatalf("late bot remained after shutdown: %d", remaining)
	}
}
