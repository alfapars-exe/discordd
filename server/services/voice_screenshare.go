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

// closeOutScreenShareLocked closes out userID's screen-share involvement in
// channelID (server serverID) as part of them vacating that channel —
// whether via an explicit leave, an admin force-disconnect, an admin move,
// or a self-initiated channel switch. Extracted from four call sites
// (LeaveChannel and JoinChannel's cross-channel branch in voice_state.go;
// MoveUser and AdminDisconnectUser in voice_admin.go) that carried this
// exact sequence verbatim, differing only in which local variables held
// the user/channel/server ids and whether wasStreaming came from a
// snapshot-before-delete or a snapshot-before-reset. Pure extraction: the
// logic, broadcast ops, payload fields, and ordering are unchanged from
// what each site already did inline.
//
// Two independent cases, run unconditionally in this order:
//  1. If wasStreaming (userID was themselves streaming in channelID),
//     clear their own screenShareViewers entry and broadcast a "leave"
//     OpScreenShareViewerUpdate for channelID (ViewerCount: 0) — this is
//     the case a vacating streamer needs.
//  2. Regardless of wasStreaming, scan every OTHER streamer's viewer set
//     for userID (they may have been watching someone else's stream,
//     possibly in a different channel) and remove them, broadcasting the
//     updated viewer count to that streamer's own channel/server.
//
// "Locked" suffix: caller MUST already hold s.mu (write lock, not RLock —
// this both reads and mutates s.screenShareViewers and reads s.states) for
// the duration of the call. Every current call site is already inside its
// own s.mu.Lock()/Unlock() bracket when it reaches this point.
func (s *voiceService) closeOutScreenShareLocked(userID, channelID, serverID string, wasStreaming bool) {
	if wasStreaming {
		delete(s.screenShareViewers, userID)
		s.broadcastToServer(serverID, ws.Event{
			Op: ws.OpScreenShareViewerUpdate,
			Data: ws.ScreenShareViewerUpdateData{
				StreamerUserID: userID,
				ChannelID:      channelID,
				ViewerCount:    0,
				ViewerUserID:   "",
				Action:         "leave",
			},
		})
	}
	for streamerID, viewers := range s.screenShareViewers {
		if viewers[userID] {
			delete(viewers, userID)
			viewerCount := len(viewers)
			if viewerCount == 0 {
				delete(s.screenShareViewers, streamerID)
			}
			if streamerState, ok := s.states[streamerID]; ok {
				s.broadcastToServer(streamerState.ServerID, ws.Event{
					Op: ws.OpScreenShareViewerUpdate,
					Data: ws.ScreenShareViewerUpdateData{
						StreamerUserID: streamerID,
						ChannelID:      streamerState.ChannelID,
						ViewerCount:    viewerCount,
						ViewerUserID:   userID,
						Action:         "leave",
					},
				})
			}
		}
	}
}
