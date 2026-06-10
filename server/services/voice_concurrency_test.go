// Package services — concurrency stress tests for the voice service.
//
// These tests hammer the shared `states` / `screenShareViewers` maps from
// many goroutines and then check post-quiescence invariants; the -race
// detector is the primary assertion. The MockBroadcaster's Fn fields are
// deliberately left nil — its methods nil-check and no-op, so concurrent
// broadcasts never touch shared test state.
//
// StartOrphanCleanup / StartAFKChecker are never started here: their tickers
// have no stop mechanism and would leak goroutines across tests.
package services

import (
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
)

// TestVoice_ConcurrentJoinLeave — 50 users churn join/leave across 3 channels.
// Every goroutine's last operation is a Leave, so once the WaitGroup drains
// the states map must be empty regardless of interleaving.
func TestVoice_ConcurrentJoinLeave(t *testing.T) {
	svc, _ := newTestVoiceService()

	channels := []string{"ch1", "ch2", "ch3"}
	const users = 50
	const iterations = 20

	var wg sync.WaitGroup
	for u := 0; u < users; u++ {
		wg.Add(1)
		go func(u int) {
			defer wg.Done()
			userID := fmt.Sprintf("user%d", u)
			for i := 0; i < iterations; i++ {
				channelID := channels[(u+i)%len(channels)]
				if err := svc.JoinChannel(userID, userID, userID, "", channelID, false, false); err != nil {
					t.Errorf("join failed user=%s: %v", userID, err)
				}
				if err := svc.LeaveChannel(userID); err != nil {
					t.Errorf("leave failed user=%s: %v", userID, err)
				}
			}
		}(u)
	}
	wg.Wait()

	if remaining := svc.GetAllVoiceStates(); len(remaining) != 0 {
		t.Errorf("expected 0 voice states after every user left, got %d", len(remaining))
	}
}

// TestVoice_ConcurrentJoinSwitchSameUser — one user switching between 3
// channels from 10 goroutines at once. The states map is keyed by userID,
// so however the joins interleave the user must end with exactly one state
// pointing at one of the requested channels.
func TestVoice_ConcurrentJoinSwitchSameUser(t *testing.T) {
	svc, _ := newTestVoiceService()

	channels := []string{"ch1", "ch2", "ch3"}
	const goroutines = 10
	const iterations = 50

	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < iterations; i++ {
				channelID := channels[(g+i)%len(channels)]
				if err := svc.JoinChannel("switcher", "switcher", "Switcher", "", channelID, false, false); err != nil {
					t.Errorf("join failed: %v", err)
				}
			}
		}(g)
	}
	wg.Wait()

	all := svc.GetAllVoiceStates()
	if len(all) > 1 {
		t.Fatalf("expected at most 1 voice state for a single user, got %d", len(all))
	}
	state := svc.GetUserVoiceState("switcher")
	if state == nil {
		t.Fatal("expected a voice state after the final join")
	}
	valid := false
	for _, ch := range channels {
		if state.ChannelID == ch {
			valid = true
			break
		}
	}
	if !valid {
		t.Errorf("channelID = %q, want one of %v", state.ChannelID, channels)
	}
}

// TestVoice_ConcurrentScreenShareViewerChurn — 30 viewers toggle watch on/off
// while the streamer stops streaming midway through the churn. UpdateState
// clears the viewer set under the same mutex that gates WatchScreenShare
// admission (which rejects when IsStreaming is false), so once the stop
// lands no watch can re-register: the final viewer count must be 0 in every
// interleaving. Each viewer deliberately ends with a watch=true attempt so
// the assertion exercises the stop-side cleanup, not just paired toggles.
func TestVoice_ConcurrentScreenShareViewerChurn(t *testing.T) {
	svc, _ := newTestVoiceService()

	if err := svc.JoinChannel("streamer", "streamer", "Streamer", "", "ch1", false, false); err != nil {
		t.Fatalf("streamer join failed: %v", err)
	}
	streaming := true
	if err := svc.UpdateState("streamer", nil, nil, &streaming); err != nil {
		t.Fatalf("start streaming failed: %v", err)
	}

	const viewers = 30
	const togglesPerViewer = 20

	// Sequential setup — viewers share the streamer's channel for realism,
	// though WatchScreenShare only validates the streamer's state.
	for v := 0; v < viewers; v++ {
		viewerID := fmt.Sprintf("viewer%d", v)
		if err := svc.JoinChannel(viewerID, viewerID, viewerID, "", "ch1", false, false); err != nil {
			t.Fatalf("viewer join failed: %v", err)
		}
	}

	var toggles atomic.Int64
	var wg sync.WaitGroup

	// Stopper — ends the stream once roughly half the churn has happened.
	// Spinning on the toggle counter (instead of sleeping) keeps the test
	// fast and guarantees termination: viewers never block, so the counter
	// always reaches the threshold.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for toggles.Load() < (viewers*togglesPerViewer)/2 {
			runtime.Gosched()
		}
		stopped := false
		if err := svc.UpdateState("streamer", nil, nil, &stopped); err != nil {
			t.Errorf("stop streaming failed: %v", err)
		}
	}()

	for v := 0; v < viewers; v++ {
		wg.Add(1)
		go func(v int) {
			defer wg.Done()
			viewerID := fmt.Sprintf("viewer%d", v)
			for i := 0; i < togglesPerViewer; i++ {
				svc.WatchScreenShare(viewerID, "streamer", true)
				svc.WatchScreenShare(viewerID, "streamer", false)
				toggles.Add(1)
			}
			// Final watch=true: either it serializes before the stop (and the
			// stop's cleanup deletes it) or after (and admission rejects it).
			svc.WatchScreenShare(viewerID, "streamer", true)
		}(v)
	}
	wg.Wait()

	if count := svc.GetScreenShareViewerCount("streamer"); count != 0 {
		t.Errorf("viewer count = %d after stream stop, want 0", count)
	}
}

// TestVoice_ConcurrentReadsDuringWrites — readers iterate every query method
// while writers churn join/update/watch/leave. No invariant beyond finishing
// without race findings: the queries copy state under RLock, so any unlocked
// read of the maps or *VoiceState fields would surface as a -race report.
func TestVoice_ConcurrentReadsDuringWrites(t *testing.T) {
	svc, _ := newTestVoiceService()

	const writers = 8
	const readers = 8
	const writerIters = 50
	const readerIters = 200

	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			userID := fmt.Sprintf("writer%d", w)
			neighborID := fmt.Sprintf("writer%d", (w+1)%writers)
			channelID := fmt.Sprintf("ch%d", w%3)
			streaming := w%2 == 0
			for i := 0; i < writerIters; i++ {
				_ = svc.JoinChannel(userID, userID, userID, "", channelID, false, false)
				_ = svc.UpdateState(userID, nil, nil, &streaming)
				// Mostly a no-op (neighbor rarely streaming) — exercises the
				// admission read path against concurrent state mutation.
				svc.WatchScreenShare(userID, neighborID, true)
				_ = svc.LeaveChannel(userID)
			}
		}(w)
	}
	for r := 0; r < readers; r++ {
		wg.Add(1)
		go func(r int) {
			defer wg.Done()
			userID := fmt.Sprintf("writer%d", r%writers)
			channelID := fmt.Sprintf("ch%d", r%3)
			for i := 0; i < readerIters; i++ {
				_ = svc.GetAllVoiceStates()
				_ = svc.GetChannelParticipants(channelID)
				_ = svc.GetUserVoiceState(userID)
				_ = svc.GetUserVoiceChannelID(userID)
				_ = svc.GetStreamCount(channelID)
				_ = svc.GetScreenShareViewerCount(userID)
				_ = svc.GetAllScreenShareViewers()
			}
		}(r)
	}
	wg.Wait()
}
