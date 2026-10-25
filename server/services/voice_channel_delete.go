package services

import (
	"context"
	"sync"

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
	if serverID == "" || channelID == "" {
		return
	}
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

	if s.musicBotHook != nil {
		logx.Go("voice-channel-delete", func() { s.musicBotHook.StopAllForChannel(channelID) })
	}
	if len(removed) == 0 {
		return
	}
	logx.Go("voice-channel-delete", func() {
		// Keep cleanup bounded: a deleted channel can have many occupants, so
		// use a small fixed worker pool rather than one goroutine per identity.
		tasks := make(chan deletedVoiceSession)
		workers := 4
		if len(removed) < workers {
			workers = len(removed)
		}
		var wg sync.WaitGroup
		wg.Add(workers)
		for i := 0; i < workers; i++ {
			logx.Go("voice-channel-delete-eviction", func() {
				defer wg.Done()
				for session := range tasks {
					s.removeDeletedChannelParticipant(ctx, session.serverID, session.channelID, session.userID)
					s.removeDeletedChannelParticipant(ctx, session.serverID, session.channelID, session.userID+"_ss")
					s.creditUsage(session.state.LiveKitInstanceID, session.state.LiveKitIsCloud, session.state.JoinedAt)
				}
			})
		}
		for _, session := range removed {
			tasks <- session
		}
		close(tasks)
		wg.Wait()
	})
	voiceLogger.Info("removed voice state for deleted channel", "server_id", serverID, "channel_id", channelID, "participant_count", len(removed))
}

var _ VoiceChannelDeletionHandler = (*voiceService)(nil)
