package services

import (
	"context"
	"time"

	"github.com/argeinfina/hichat/database"
)

type queueWakerKey struct{}

// WithQueueWaker attaches the PostgreSQL queue wake fan-out to a worker start
// context. Workers started without one fall back to idle polling.
func WithQueueWaker(ctx context.Context, waker *database.QueueWaker) context.Context {
	return context.WithValue(ctx, queueWakerKey{}, waker)
}

// queueWake returns the wake channel for table, or nil (never fires).
func queueWake(ctx context.Context, table string) <-chan struct{} {
	waker, _ := ctx.Value(queueWakerKey{}).(*database.QueueWaker)
	return waker.Subscribe(table)
}

// idlePoll paces a queue worker: it polls at base while work keeps arriving and
// doubles the interval up to max while the queue stays empty. Every poll holds
// a pooled connection for at least one remote round trip, so an idle server
// must not poll several times per second; a wake resets it to base.
type idlePoll struct{ base, max, cur time.Duration }

func newIdlePoll(base, max time.Duration) *idlePoll {
	return &idlePoll{base: base, max: max, cur: base}
}

// after records whether the last poll found work and returns the next delay.
func (p *idlePoll) after(worked bool) time.Duration {
	if worked {
		p.cur = p.base
	} else if p.cur < p.max {
		p.cur = min(p.cur*2, p.max)
	}
	return p.cur
}

func (p *idlePoll) wake() { p.cur = p.base }
