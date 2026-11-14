package services

import (
	"context"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg/logx"
)

// VoiceChannelDeletionHandler is the narrow hook ChannelService invokes only
// after the channel row has been deleted successfully.
type VoiceChannelDeletionHandler interface {
	DeleteVoiceChannel(ctx context.Context, serverID, channelID string)
}

type deletedVoiceSession struct {
	userID    string
	state     models.VoiceState
	serverID  string
	channelID string
}

// DeleteVoiceChannel removes all in-memory state associated with a channel.
// It marks a global channel-delete epoch under the same lock as JoinChannel's
// final state mutation, so a join which fetched the row just before deletion
// cannot resurrect state after this cleanup. The epoch is global to keep the
// guard bounded; a simultaneous join to another server may need a retry.
func (s *voiceService) DeleteVoiceChannel(ctx context.Context, serverID, channelID string) {
	s.deleteVoiceChannelAt(ctx, serverID, channelID, time.Now())
}

func (s *voiceService) deleteVoiceChannelAt(ctx context.Context, serverID, channelID string, endedAt time.Time) {
	finishOperation, admitted := s.operations.begin()
	if admitted {
		defer finishOperation()
	}

	if serverID == "" || channelID == "" {
		return
	}
	removed := s.detachVoiceChannel(serverID, channelID)
	// The channel row was already deleted: always fence pending joins and
	// remove in-memory state, even after usage admission closes.
	creditAll := func() {
		runDeletedVoiceSessions(removed, func(session deletedVoiceSession) { s.creditDeletedVoiceSession(session, endedAt) })
	}
	if !admitted {
		// The caller owns late committed cleanup. Join every bounded accounting
		// attempt before any music/network work can delay another session.
		creditAll()
		if s.musicBotHook != nil {
			logx.Run("voice-channel-delete-music", func() { s.musicBotHook.StopAllForChannel(channelID) })
		}
		for _, session := range removed {
			s.evictDeletedVoiceSession(ctx, session)
		}
		return
	}
	s.operations.child(func() {
		creditAll()
		if s.musicBotHook != nil {
			s.operations.child(func() { logx.Run("voice-channel-delete-music", func() { s.musicBotHook.StopAllForChannel(channelID) }) })
		}
		runDeletedVoiceSessions(removed, func(session deletedVoiceSession) { s.evictDeletedVoiceSession(ctx, session) })
	})
	voiceLogger.Info("removed voice state for deleted channel", "server_id", serverID, "channel_id", channelID, "participant_count", len(removed))
}

var _ VoiceChannelDeletionHandler = (*voiceService)(nil)

// Both accounting and media phases are bounded and joined. Recover per item
// so a faulty callback cannot strand later accepted work behind dead workers.
func runDeletedVoiceSessions(sessions []deletedVoiceSession, work func(deletedVoiceSession)) {
	tasks := make(chan deletedVoiceSession)
	var joined sync.WaitGroup
	workers := min(4, len(sessions))
	joined.Add(workers)
	for i := 0; i < workers; i++ {
		logx.Go("voice-channel-delete-worker", func() {
			defer joined.Done()
			for session := range tasks {
				logx.Run("voice-channel-delete-session", func() { work(session) })
			}
		})
	}
	for _, session := range sessions {
		tasks <- session
	}
	close(tasks)
	joined.Wait()
}

func (s *voiceService) evictDeletedVoiceSession(ctx context.Context, session deletedVoiceSession) {
	for _, identity := range []string{session.userID, session.userID + "_ss"} {
		logx.Run("voice-channel-delete-identity", func() { s.removeDeletedChannelParticipant(ctx, session.serverID, session.channelID, identity) })
	}
}

// detachVoiceChannel fences joins and returns exclusive ownership of removed sessions.
// All state mutation remains under s.mu; repository/media work runs afterward.
func (s *voiceService) detachVoiceChannel(serverID, channelID string) []deletedVoiceSession {
	var removed []deletedVoiceSession
	removedUsers := make(map[string]struct{})
	snapshotChanged := false
	s.mu.Lock()
	s.channelDeleteEpoch++
	for userID, state := range s.states {
		if state.ChannelID != channelID || state.ServerID != serverID {
			continue
		}
		removed = append(removed, deletedVoiceSession{
			userID:    userID,
			state:     *state,
			serverID:  state.ServerID,
			channelID: state.ChannelID,
		})
		removedUsers[userID] = struct{}{}
		snapshotChanged = true
		delete(s.states, userID)
		delete(s.offlineSince, userID)
		s.closeOutScreenShareLocked(userID, channelID, serverID, state.IsStreaming)
	}
	for userID, grant := range s.forceMoveGrants {
		if grant.channelID == channelID {
			delete(s.forceMoveGrants, userID)
		}
	}
	// Remove only viewer bookkeeping attached to the removed participants.
	// There may be orphaned entries from other channels; without their channel
	// identity, pruning them here would cross the deletion scope.
	for streamerID, viewers := range s.screenShareViewers {
		if _, removedStreamer := removedUsers[streamerID]; removedStreamer {
			delete(s.screenShareViewers, streamerID)
			snapshotChanged = true
			continue
		}
		removedViewer := false
		for removedUserID := range removedUsers {
			if _, exists := viewers[removedUserID]; exists {
				delete(viewers, removedUserID)
				removedViewer = true
				snapshotChanged = true
			}
		}
		if removedViewer && len(viewers) == 0 {
			delete(s.screenShareViewers, streamerID)
		}
	}
	if snapshotChanged {
		s.bumpVoiceRevisionLocked()
	}
	s.cleanupRoomPassphraseIfEmpty(channelID)
	s.mu.Unlock()
	return removed
}

// Isolate an unexpected recorder panic without abandoning later sessions or
// media cleanup. This is an attempt, not a successful handoff or a retry.
func (s *voiceService) creditDeletedVoiceSession(session deletedVoiceSession, endedAt time.Time) {
	logx.Run("voice-channel-delete-credit", func() {
		s.creditUsageSession(session.state.UsageSessionID, session.state.LiveKitInstanceID, session.state.LiveKitIsCloud, session.state.JoinedAt, endedAt)
	})
}
