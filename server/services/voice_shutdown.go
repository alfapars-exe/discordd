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
		channels := make(map[channel]struct{})
		s.mu.RLock()
		for _, state := range s.states {
			channels[channel{state.ServerID, state.ChannelID}] = struct{}{}
		}
		s.mu.RUnlock()
		endedAt := time.Now()
		workers := min(4, len(channels))
		tasks := make(chan channel)
		var joined sync.WaitGroup
		joined.Add(workers)
		for i := 0; i < workers; i++ {
			logx.Go("voice-session-shutdown", func() {
				defer joined.Done()
				for c := range tasks {
					s.deleteVoiceChannelAt(context.Background(), c.serverID, c.channelID, endedAt)
				}
			})
		}
		for c := range channels {
			tasks <- c
		}
		close(tasks)
		joined.Wait()
	})
}
