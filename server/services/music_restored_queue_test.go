package services

import (
	"context"
	"crypto/sha256"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/google/uuid"
	"sync"
	"testing"
	"time"
)

func restoredQueueFixture(t *testing.T) (*musicBotService, musicControlStore, []string) {
	t.Helper()
	s, store := guardedMusicFixture(t)
	delete(s.bots, "ch")
	ids := []string{uuid.NewString(), uuid.NewString()}
	session := models.MusicSession{ChannelID: "ch", ServerID: "srv", RepeatMode: "all", Queue: []models.MusicTrack{{QueueItemID: ids[0], VideoID: "same"}, {QueueItemID: ids[1], VideoID: "same"}}}
	s.restored["ch"] = session
	if err := s.sessions.Save(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	_ = guardedCommand(t, s, "remove")
	return s, store, ids
}

func TestMusicRestoredQueueEditDurableReplayAndEmpty(t *testing.T) {
	s, _, ids := restoredQueueFixture(t)
	cmd := guardedCommand(t, s, "reorder")
	cmd.QueueItemIDs = []string{ids[1], ids[0]}
	first, err := s.ApplyMusicCommand(context.Background(), "actor", "ch", cmd)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.ApplyMusicCommand(context.Background(), "actor", "ch", cmd)
	if err != nil || string(first) != string(second) {
		t.Fatalf("replay %s %v", second, err)
	}
	state := s.GetState("ch")
	if state.IsActive || !state.IsPaused || state.Revision != 1 || state.Queue[0].QueueItemID != ids[1] || s.lookupBot("ch") != nil {
		t.Fatalf("state %#v", state)
	}
	durable, err := s.sessions.List(context.Background())
	if err != nil || len(durable) != 1 || durable[0].Queue[0].QueueItemID != ids[1] || durable[0].Revision != 1 {
		t.Fatalf("durable %#v %v", durable, err)
	}
	for _, id := range ids {
		remove := guardedCommand(t, s, "remove")
		remove.QueueItemID = id
		if _, err := s.ApplyMusicCommand(context.Background(), "actor", "ch", remove); err != nil {
			t.Fatal(err)
		}
	}
	durable, err = s.sessions.List(context.Background())
	if err != nil || len(durable) != 0 {
		t.Fatalf("empty durable %#v %v", durable, err)
	}
	state = s.GetState("ch")
	if state.Revision != 3 || state.IsActive || len(state.Queue) != 0 {
		t.Fatalf("empty state %#v", state)
	}
}

func TestMusicRestoredQueueFailureAndAuthorizationPreserveState(t *testing.T) {
	for _, kind := range []string{"storage", "access", "duplicate", "missing"} {
		t.Run(kind, func(t *testing.T) {
			s, store, ids := restoredQueueFixture(t)
			cmd := guardedCommand(t, s, "reorder")
			cmd.QueueItemIDs = []string{ids[1], ids[0]}
			ctx := context.Background()
			switch kind {
			case "storage":
				s.sessions = failedMusicCommandStore{MusicSessionStore: s.sessions, musicControlStore: store}
			case "access":
				checks := 0
				ctx = WithMusicAccessCheck(ctx, func(context.Context) error {
					checks++
					if checks >= 3 {
						return pkg.ErrForbidden
					}
					return nil
				})
			case "duplicate":
				cmd.QueueItemIDs = []string{ids[0], ids[0]}
			case "missing":
				cmd.Action = "remove"
				cmd.QueueItemID = uuid.NewString()
			}
			if _, err := s.ApplyMusicCommand(ctx, "actor", "ch", cmd); err == nil {
				t.Fatal("expected failure")
			}
			state := s.GetState("ch")
			if state.Revision != 0 || len(state.Queue) != 2 || state.Queue[0].QueueItemID != ids[0] || s.lookupBot("ch") != nil {
				t.Fatalf("mutated %#v", state)
			}
			durable, err := s.sessions.List(context.Background())
			if err != nil || len(durable) != 1 || durable[0].Revision != 0 {
				t.Fatalf("durable %#v %v", durable, err)
			}
			if kind == "storage" {
				s.sessions = s.sessions.(failedMusicCommandStore).MusicSessionStore
				if _, err := s.ApplyMusicCommand(context.Background(), "actor", "ch", cmd); err != nil {
					t.Fatalf("retry after storage recovery: %v", err)
				}
				if s.GetState("ch").Revision != 1 {
					t.Fatal("retry did not commit exactly once")
				}
			}
		})
	}
}

func TestMusicRestoredQueueConcurrentEditsConflict(t *testing.T) {
	s, _, ids := restoredQueueFixture(t)
	a := guardedCommand(t, s, "remove")
	a.QueueItemID = ids[0]
	b := a
	b.RequestID = uuid.NewString()
	b.QueueItemID = ids[1]
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, cmd := range []MusicCommand{a, b} {
		wg.Add(1)
		go func(c MusicCommand) {
			defer wg.Done()
			_, err := s.ApplyMusicCommand(context.Background(), "actor", "ch", c)
			results <- err
		}(cmd)
	}
	wg.Wait()
	close(results)
	ok, conflicts := 0, 0
	for err := range results {
		switch {
		case err == nil:
			ok++
		case errors.Is(err, pkg.ErrConflict):
			conflicts++
		default:
			t.Fatal(err)
		}
	}
	if ok != 1 || conflicts != 1 || s.GetState("ch").Revision != 1 || len(s.GetState("ch").Queue) != 1 {
		t.Fatalf("ok=%d conflicts=%d state=%#v", ok, conflicts, s.GetState("ch"))
	}
}

func TestMusicRestoredQueueEditOrStopWinsConnectingRestore(t *testing.T) {
	for _, action := range []string{"remove", "stop"} {
		t.Run(action, func(t *testing.T) {
			s, _, ids := restoredQueueFixture(t)
			started, release := make(chan struct{}), make(chan struct{})
			var releaseOnce sync.Once
			t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
			s.connectBotFn = func(context.Context, *botInstance) error { close(started); <-release; return nil }
			restore := guardedCommand(t, s, "restore")
			done := make(chan error, 1)
			go func() { _, err := s.ApplyMusicCommand(context.Background(), "actor", "ch", restore); done <- err }()
			select {
			case <-started:
			case <-time.After(3 * time.Second):
				t.Fatal("restore did not connect")
			}
			command := restore
			command.Action, command.RequestID, command.QueueItemID = action, uuid.NewString(), ids[0]
			restoreStripe := sha256.Sum256([]byte("actor\x00ch\x00" + restore.RequestID))
			for attempts := 0; ; attempts++ {
				commandStripe := sha256.Sum256([]byte("actor\x00ch\x00" + command.RequestID))
				if commandStripe[0] != restoreStripe[0] {
					break
				}
				if attempts == 16 {
					t.Fatal("could not select a different request lock stripe")
				}
				command.RequestID = uuid.NewString()
			}
			_, editErr := s.ApplyMusicCommand(context.Background(), "actor", "ch", command)
			releaseOnce.Do(func() { close(release) })
			if editErr != nil {
				t.Fatal(editErr)
			}
			select {
			case err := <-done:
				if err == nil {
					t.Fatal("stale restore succeeded")
				}
			case <-time.After(3 * time.Second):
				t.Fatal("restore remained blocked")
			}
			state := s.GetState("ch")
			if state.IsActive {
				t.Fatalf("unexpected playback: %#v", state)
			}
			if action == "remove" {
				if state.Revision != 1 || len(state.Queue) != 1 || state.Queue[0].QueueItemID != ids[1] {
					t.Fatalf("lost edit: %#v", state)
				}
				if bot := s.lookupBot("ch"); bot != nil {
					bot.mu.Lock()
					running := bot.loopRunning
					bot.mu.Unlock()
					if running {
						t.Fatal("stale restore started loop")
					}
				}
			} else if len(state.Queue) != 0 || s.lookupBot("ch") != nil {
				t.Fatalf("stop resurrected: %#v", state)
			}
		})
	}
}
