package main

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"testing/synctest"
	"time"
)

func TestVoiceActivityWriterOverflowIsNonBlockingAndDrainsFIFO(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		release := make(chan struct{})
		var written []voiceActivityUpdate
		w := newVoiceActivityWriter(func(ctx context.Context, update voiceActivityUpdate) {
			deadline, ok := ctx.Deadline()
			if !ok || deadline.Sub(time.Now()) != voiceActivityBudget {
				t.Error("activity task must receive one five-second budget")
			}
			<-release
			written = append(written, update)
		})
		t.Cleanup(w.stop)
		if !w.enqueue("active", "channel") {
			t.Fatal("first activity update rejected")
		}
		synctest.Wait()
		for i := range voiceActivityQueueSize {
			if !w.enqueue(fmt.Sprint(i), "channel") {
				t.Fatalf("queue rejected item %d before capacity", i)
			}
		}
		for range 10 {
			if w.enqueue("overflow", "channel") {
				t.Fatal("overflow was admitted")
			}
		}
		if w.dropped.Load() != 10 {
			t.Fatal("overflow should aggregate its dropped count")
		}
		close(release)
		w.stop()
		if len(written) != voiceActivityQueueSize+1 || written[0].userID != "active" {
			t.Fatalf("drained %d updates, want %d", len(written), voiceActivityQueueSize+1)
		}
		for i := range voiceActivityQueueSize {
			if written[i+1].userID != fmt.Sprint(i) || written[i+1].channelID != "channel" {
				t.Fatalf("FIFO item %d: %+v", i, written[i+1])
			}
		}
		if w.enqueue("stopped", "channel") {
			t.Fatal("stopped writer admitted more work")
		}
		w.stop()
	})
}

func TestVoiceActivityWriterStopBoundsDrainAndJoinsCanceledWork(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var started []string
		var completed []error
		w := newVoiceActivityWriter(func(ctx context.Context, update voiceActivityUpdate) {
			started = append(started, update.userID)
			<-ctx.Done()
			completed = append(completed, ctx.Err())
		})
		t.Cleanup(w.stop)
		w.enqueue("first", "channel")
		synctest.Wait()
		w.enqueue("second", "channel")
		w.enqueue("discarded", "channel")
		// The first task expires during drain; the second must inherit worker
		// cancellation when the whole drain budget expires one second later.
		time.Sleep(time.Second)
		start := time.Now()
		w.stop()
		if elapsed := time.Since(start); elapsed != voiceActivityBudget {
			t.Fatalf("shutdown took %s, want %s", elapsed, voiceActivityBudget)
		}
		if len(started) != 2 || len(completed) != 2 {
			t.Fatalf("shutdown did not join active work/discard pending work: started=%v completed=%v", started, completed)
		}
		if !errors.Is(completed[0], context.DeadlineExceeded) || !errors.Is(completed[1], context.Canceled) {
			t.Fatalf("task and shutdown cancellation=%v", completed)
		}
		select {
		case <-w.done:
		default:
			t.Fatal("shutdown returned before worker exit")
		}
	})
}

func TestVoiceActivityWriterPanicDoesNotStrandFollowingUpdates(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var completed int
		w := newVoiceActivityWriter(func(_ context.Context, update voiceActivityUpdate) {
			if update.userID == "panic" {
				panic("fixture failure")
			}
			completed++
		})
		t.Cleanup(w.stop)
		w.enqueue("panic", "channel")
		w.enqueue("next", "channel")
		w.stop()
		if completed != 1 {
			t.Fatal("panic stranded subsequent activity")
		}
	})
}
