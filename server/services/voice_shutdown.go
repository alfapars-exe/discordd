package services

import (
	"context"
	"github.com/argeinfina/hichat/pkg/logx"
	"sync"
	"time"
)

// ShutdownVoiceSessions joins producers and finalizes remaining sessions before
// the recovery worker, log sinks and database close. Concurrent calls join the
// same terminal run. Channel cleanup does not delete repository rows.
func (s *voiceService) ShutdownVoiceSessions() {
	s.sessionShutdown.Do(func() {
		s.StopMaintenance()
		s.ShutdownUsageProducers()
		type channel struct{ serverID, channelID string }
		channels := make(map[channel][]deletedVoiceSession)
		s.mu.RLock()
		for _, state := range s.states {
			channels[channel{state.ServerID, state.ChannelID}] = nil
		}
		s.mu.RUnlock()
		endedAt := time.Now()
		// Attempt every accounting handoff before any music/network work can
		// stall a later session. Detachment gives this owner exclusive snapshots.
		for c := range channels {
			sessions := s.detachVoiceChannel(c.serverID, c.channelID)
			channels[c] = sessions
			for _, session := range sessions {
				s.creditUsageSession(session.state.UsageSessionID, session.state.LiveKitInstanceID, session.state.LiveKitIsCloud, session.state.JoinedAt, endedAt)
			}
		}
		workers := min(4, len(channels))
		tasks := make(chan channel)
		var joined sync.WaitGroup
		joined.Add(workers)
		for i := 0; i < workers; i++ {
			logx.Go("voice-session-shutdown", func() {
				defer joined.Done()
				for c := range tasks {
					if s.musicBotHook != nil {
						s.musicBotHook.StopAllForChannel(c.channelID)
					}
					for _, session := range channels[c] {
						s.evictDeletedVoiceSession(context.Background(), session)
					}
				}
			})
		}
		for c := range channels {
			tasks <- c
		}
		close(tasks)
		joined.Wait()
		s.clearFinalVoiceMetadata()
	})
}

// All owned cleanup has joined. Also forget orphan entries without active
// participants; per-channel cleanup intentionally preserves unrelated entries.
func (s *voiceService) clearFinalVoiceMetadata() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessionsFinalized = true
	if len(s.screenShareViewers) > 0 {
		s.bumpVoiceRevisionLocked()
	}
	clear(s.roomPassphrases)
	clear(s.roomKeyContexts)
	clear(s.roomKeyVersions)
	clear(s.screenShareViewers)
	clear(s.forceMoveGrants)
	clear(s.offlineSince)
}
