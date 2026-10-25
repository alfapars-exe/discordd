package services

import (
	"github.com/argeinfina/hichat/ws"
	"time"
)

// Never accepted from a client payload. A live Update alone can create this
// candidate; snapshots, grant/policy reconciliation and fallback selection cannot.
type gameActivityTransition struct {
	connection  uint64
	incarnation string
}

// Recheck after repository policy work; the target gate still serializes source
// replacement while the clock can independently expire its publication lease.
func (s *GameActivityService) isSelectedActivityTransition(target string, candidate gameActivityTransition) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.selectedTransitionLocked(target, candidate, time.Now())
}

// Caller holds activity.mu and the target gate. Ties fail closed rather than
// attributing one physical source's update to another selected source.
func (s *GameActivityService) selectedTransitionLocked(target string, candidate gameActivityTransition, now time.Time) bool {
	source, ok := s.sources[target][candidate.connection]
	if !ok || source.incarnation != candidate.incarnation || !now.Before(source.leaseUntil) {
		return false
	}
	for id, other := range s.sources[target] {
		if id != candidate.connection && now.Before(other.leaseUntil) && !other.changedAt.Before(source.changedAt) {
			return false
		}
	}
	return true
}

func (s *GameActivityService) deliverActivityTransition(viewer, target, server string, game *ws.GameActivityGame, transition bool) {
	s.mu.Lock()
	revision := s.revisions[target] + 1
	s.revisions[target] = revision
	s.mu.Unlock()
	if s.hub != nil {
		s.hub.BroadcastToUsers([]string{viewer}, ws.Event{Op: ws.OpGameActivityUpdate, Data: ws.GameActivityData{
			UserID: target, ServerID: server, Game: game, Revision: revision, Epoch: s.epoch,
			Transition: transition && game != nil && server == "" && viewer != target,
		}})
	}
}
