package services

import (
	"context"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
)

func TestIdlePollBacksOffWhileEmptyAndResets(t *testing.T) {
	p := newIdlePoll(500*time.Millisecond, 2*time.Second)
	for i, want := range []time.Duration{time.Second, 2 * time.Second, 2 * time.Second} {
		if got := p.after(false); got != want {
			t.Fatalf("empty poll %d: got %s, want %s", i, got, want)
		}
	}
	if got := p.after(true); got != 500*time.Millisecond {
		t.Fatalf("busy poll: got %s, want base", got)
	}
	p.after(false)
	p.wake()
	if p.cur != p.base {
		t.Fatalf("wake left interval at %s", p.cur)
	}
}

func TestQueueWakeFromContext(t *testing.T) {
	if queueWake(context.Background(), database.WakeDMDelivery) != nil {
		t.Fatal("worker without a waker must get a nil channel")
	}
	w := database.NewQueueWaker()
	ch := queueWake(WithQueueWaker(context.Background(), w), database.WakeDMDelivery)
	w.Wake(database.WakeDMDelivery)
	select {
	case <-ch:
	default:
		t.Fatal("context waker was not used")
	}
}
