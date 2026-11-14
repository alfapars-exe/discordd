package services

import (
	"context"
	"github.com/argeinfina/hichat/models"
	"sync"
	"testing"
	"time"
)

func TestMusicStopAllJoinsAcceptedPlaybackWorker(t *testing.T) {
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
	stopped := make(chan struct{})
	go func() { svc.StopAll(); close(stopped) }()
	select {
	case <-stopped:
		t.Fatal("StopAll returned while accepted playback worker was running")
	case <-time.After(25 * time.Millisecond):
	}
	once.Do(func() { close(release) })
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("StopAll did not join playback")
	}
}
