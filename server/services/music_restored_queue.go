package services

import (
	"context"
	"encoding/json"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// Caller holds the channel lifecycle lock. Editing a dormant queue never
// creates a publisher or starts playback. The receipt and queue commit together.
func (s *musicBotService) editRestoredMusicQueue(ctx context.Context, store musicControlStore, head models.MusicControlHead, op models.MusicOperation, command MusicCommand) (json.RawMessage, error) {
	s.mu.RLock()
	next, exists := s.restored[op.ChannelID]
	s.mu.RUnlock()
	if !exists {
		return nil, pkg.ErrNotFound
	}
	if next.SessionID != op.SessionID || next.Revision != op.ExpectedRevision || next.ServerID != head.ServerID {
		return nil, pkg.ErrConflict
	}
	next.Queue = cloneMusicTracks(next.Queue)
	if command.Action == "remove" {
		index := -1
		for i, track := range next.Queue {
			if track.QueueItemID == command.QueueItemID {
				index = i
				break
			}
		}
		if index < 0 {
			return nil, pkg.ErrNotFound
		}
		next.Queue = append(next.Queue[:index], next.Queue[index+1:]...)
	} else {
		if len(command.QueueItemIDs) != len(next.Queue) || len(command.QueueItemIDs) > maxQueueLen {
			return nil, pkg.ErrBadRequest
		}
		byID := make(map[string]models.MusicTrack, len(next.Queue))
		for _, track := range next.Queue {
			byID[track.QueueItemID] = track
		}
		ordered := make([]models.MusicTrack, 0, len(next.Queue))
		for _, id := range command.QueueItemIDs {
			track, ok := byID[id]
			if !ok {
				return nil, pkg.ErrBadRequest
			}
			ordered = append(ordered, track)
			delete(byID, id)
		}
		next.Queue = ordered
	}
	next.Revision++
	head.Revision = next.Revision
	var persisted *models.MusicSession
	if len(next.Queue) > 0 {
		persisted = &next
	}
	if err := RecheckMusicAccess(ctx); err != nil {
		return nil, err
	}
	receipt, replayed, err := store.CommitMusicOperation(ctx, models.MusicOperationCommit{Operation: op, NextHead: head, Session: persisted, Result: json.RawMessage(`{"status":"ok"}`)})
	if err != nil || replayed {
		return receipt.Result, err
	}
	s.mu.Lock()
	if persisted == nil {
		delete(s.restored, op.ChannelID)
	} else {
		s.restored[op.ChannelID] = next
	}
	s.mu.Unlock()
	state := &models.MusicBotChannelState{SessionID: head.SessionID, ChannelID: next.ChannelID, ServerID: next.ServerID, Revision: next.Revision, IsPaused: true, Queue: next.Queue, RepeatMode: next.RepeatMode}
	if clean, err := s.sanitizeMusicState(ctx, state); err == nil {
		s.publishMusicState(next.ServerID, next.ChannelID, clean, false)
	}
	return receipt.Result, nil
}
