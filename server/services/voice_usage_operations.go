package services

import (
	"github.com/argeinfina/hichat/pkg/logx"
	"sync"
	"time"
)

// voiceUsageOperations closes root admission while allowing already admitted
// operations to register child credits and media cleanup before releasing their own slot.
// The final slot closes done, so child Add never races a zero-count Wait.
type voiceUsageOperations struct {
	mu      sync.Mutex
	closing bool
	active  int
	done    chan struct{}
}

func (g *voiceUsageOperations) begin() (func(), bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closing {
		return nil, false
	}
	if g.done == nil {
		g.done = make(chan struct{})
	}
	g.active++
	return g.finish, true
}
func (g *voiceUsageOperations) child(work func()) bool {
	g.mu.Lock()
	if g.closing && g.active == 0 {
		g.mu.Unlock()
		return false
	}
	if g.done == nil {
		g.done = make(chan struct{})
	}
	g.active++
	g.mu.Unlock()
	logx.Go("voice-usage-producer", func() { defer g.finish(); work() })
	return true
}
func (g *voiceUsageOperations) finish() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.active--
	if g.closing && g.active == 0 {
		close(g.done)
	}
}
func (g *voiceUsageOperations) closeAndWait() {
	g.mu.Lock()
	if g.done == nil {
		g.done = make(chan struct{})
	}
	if !g.closing {
		g.closing = true
		if g.active == 0 {
			close(g.done)
		}
	}
	done := g.done
	g.mu.Unlock()
	<-done
}

func (s *voiceService) ShutdownUsageProducers() { s.usageOperations.closeAndWait() }

func (s *voiceService) dispatchUsageCredit(sessionID, instanceID string, isCloud bool, joinedAt, endedAt time.Time) {
	if !s.usageOperations.child(func() { s.creditUsageSession(sessionID, instanceID, isCloud, joinedAt, endedAt) }) {
		voiceLogger.Error("usage producer rejected after terminal shutdown")
	}
}
