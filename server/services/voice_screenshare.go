// Package services — screen share viewer tracking.
// Server-side count of who is watching each streamer's screen; used to render
// viewer counts in the sidebar and for metrics.
package services

import (
	"github.com/argeinfina/hichat/ws"
)

func (s *voiceService) WatchScreenShare(viewerUserID, streamerUserID string, watching bool) {
	s.mu.Lock()

	// Verify streamer is actually in voice and streaming
	streamerState, ok := s.states[streamerUserID]
	if !ok || !streamerState.IsStreaming {
		s.mu.Unlock()
		return
	}

	// security scan 2026-07-31, finding N-19: the viewer must be sitting in
	// the streamer's own voice channel. Without this any authenticated user
	// could inflate a stranger's viewer count and make the streamer's server
	// broadcast a bogus screen_share_viewer_update naming them.
	//
	// This check also runs when watching == false. A viewer who has already
	// left the streamer's channel can no longer send a valid "stop watching"
	// either, but that's fine: LeaveChannel and CleanupViewersForStreamer
	// already remove that viewer from screenShareViewers on channel exit, so
	// there's nothing left here for a late "stop" to clean up. Allowing it
	// through would just be a second, redundant code path.
	viewerState, viewerOK := s.states[viewerUserID]
	if !viewerOK || viewerState.ChannelID != streamerState.ChannelID {
		s.mu.Unlock()
		return
	}

	if watching {
		if s.screenShareViewers[streamerUserID] == nil {
			s.screenShareViewers[streamerUserID] = make(map[string]bool)
		}
		s.screenShareViewers[streamerUserID][viewerUserID] = true
	} else {
		if viewers, exists := s.screenShareViewers[streamerUserID]; exists {
			delete(viewers, viewerUserID)
			if len(viewers) == 0 {
				delete(s.screenShareViewers, streamerUserID)
			}
		}
	}

	viewerCount := len(s.screenShareViewers[streamerUserID])
	channelID := streamerState.ChannelID
	serverID := streamerState.ServerID
	s.mu.Unlock()

	action := "leave"
	if watching {
		action = "join"
	}

	s.broadcastToServer(serverID, ws.Event{
		Op: ws.OpScreenShareViewerUpdate,
		Data: ws.ScreenShareViewerUpdateData{
			StreamerUserID: streamerUserID,
			ChannelID:      channelID,
			ViewerCount:    viewerCount,
			ViewerUserID:   viewerUserID,
			Action:         action,
		},
	})
}

func (s *voiceService) GetScreenShareViewerCount(streamerUserID string) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.screenShareViewers[streamerUserID])
}

// GetAllScreenShareViewers returns a snapshot of the viewer map keyed by
// streamer user ID. Each value is the slice of viewer user IDs currently
// watching that streamer's share. Used by the ws handler to seed state-sync
// for newly connecting clients so they see existing viewers without
// waiting for the next join/leave delta.
func (s *voiceService) GetAllScreenShareViewers() map[string][]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string][]string, len(s.screenShareViewers))
	for streamerID, viewers := range s.screenShareViewers {
		ids := make([]string, 0, len(viewers))
		for viewerID := range viewers {
			ids = append(ids, viewerID)
		}
		out[streamerID] = ids
	}
	return out
}

// GetScreenShareStats returns the total number of active streamers and total viewers.
func (s *voiceService) GetScreenShareStats() (streamers int, viewers int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, state := range s.states {
		if state.IsStreaming {
			streamers++
		}
	}
	for _, viewerSet := range s.screenShareViewers {
		viewers += len(viewerSet)
	}
	return
}

func (s *voiceService) CleanupViewersForStreamer(streamerUserID string) {
	s.mu.Lock()
	delete(s.screenShareViewers, streamerUserID)
	s.mu.Unlock()
}
