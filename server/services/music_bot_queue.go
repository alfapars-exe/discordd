package services

import (
	"context"
	"fmt"
	"math/rand"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/google/uuid"
)

func (s *musicBotService) RemoveQueueItem(channelID, queueItemID string, expectedRevision uint64) error {
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		return err
	}
	if _, err := uuid.Parse(queueItemID); err != nil {
		return fmt.Errorf("%w: invalid queue item id", pkg.ErrBadRequest)
	}
	bot, err := s.lockControlSession(channelID)
	if err != nil {
		return err
	}
	bot.mu.Lock()
	if expectedRevision != bot.revision {
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		return fmt.Errorf("%w: music queue changed", pkg.ErrConflict)
	}
	index := -1
	for i := range bot.queue {
		if bot.queue[i].QueueItemID == queueItemID {
			index = i
			break
		}
	}
	if index < 0 {
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		return pkg.ErrNotFound
	}
	previousQueue := cloneMusicTracks(bot.queue)
	previousRevision := bot.revision
	bot.queue = append(bot.queue[:index], bot.queue[index+1:]...)
	bot.revision++
	bot.mu.Unlock()
	if err := s.persistMutation(bot, func() { bot.queue = previousQueue; bot.revision = previousRevision }); err != nil {
		bot.sessionMu.Unlock()
		return err
	}
	bot.sessionMu.Unlock()
	s.broadcastState(bot)
	return nil
}

func (s *musicBotService) ReorderQueue(channelID string, queueItemIDs []string, expectedRevision uint64) error {
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		return err
	}
	if len(queueItemIDs) > maxQueueLen {
		return fmt.Errorf("%w: queue too large", pkg.ErrBadRequest)
	}
	for _, id := range queueItemIDs {
		if _, err := uuid.Parse(id); err != nil {
			return fmt.Errorf("%w: invalid queue item id", pkg.ErrBadRequest)
		}
	}
	bot, err := s.lockControlSession(channelID)
	if err != nil {
		return err
	}
	bot.mu.Lock()
	if expectedRevision != bot.revision {
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		return fmt.Errorf("%w: music queue changed", pkg.ErrConflict)
	}
	reordered, err := reorderMusicTracks(bot.queue, queueItemIDs)
	if err != nil {
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		return err
	}
	previousQueue := cloneMusicTracks(bot.queue)
	previousRevision := bot.revision
	bot.queue = reordered
	bot.revision++
	bot.mu.Unlock()
	if err := s.persistMutation(bot, func() { bot.queue = previousQueue; bot.revision = previousRevision }); err != nil {
		bot.sessionMu.Unlock()
		return err
	}
	bot.sessionMu.Unlock()
	s.broadcastState(bot)
	return nil
}

func (s *musicBotService) ShuffleQueue(channelID string, expectedRevision uint64) error {
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		return err
	}
	bot, err := s.lockControlSession(channelID)
	if err != nil {
		return err
	}
	bot.mu.Lock()
	if expectedRevision != bot.revision {
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
		return fmt.Errorf("%w: music queue changed", pkg.ErrConflict)
	}
	previousQueue := cloneMusicTracks(bot.queue)
	previousRevision := bot.revision
	rand.Shuffle(len(bot.queue), func(i, j int) { bot.queue[i], bot.queue[j] = bot.queue[j], bot.queue[i] }) // #nosec G404 -- playback order is not security-sensitive
	bot.revision++
	bot.mu.Unlock()
	if err := s.persistMutation(bot, func() { bot.queue = previousQueue; bot.revision = previousRevision }); err != nil {
		bot.sessionMu.Unlock()
		return err
	}
	bot.sessionMu.Unlock()
	s.broadcastState(bot)
	return nil
}

func (s *musicBotService) SetRepeatMode(channelID, mode string) error {
	if err := s.CheckLegacyControl(context.Background(), channelID); err != nil {
		return err
	}
	if mode != "off" && mode != "one" && mode != "all" {
		return fmt.Errorf("%w: invalid repeat mode", pkg.ErrBadRequest)
	}
	bot, err := s.lockControlSession(channelID)
	if err != nil {
		return err
	}
	bot.mu.Lock()
	previousMode := bot.repeatMode
	previousRevision := bot.revision
	bot.repeatMode = mode
	bot.revision++
	bot.mu.Unlock()
	if err := s.persistMutation(bot, func() { bot.repeatMode = previousMode; bot.revision = previousRevision }); err != nil {
		bot.sessionMu.Unlock()
		return err
	}
	bot.sessionMu.Unlock()
	s.broadcastState(bot)
	return nil
}

func reorderMusicTracks(queue []models.MusicTrack, queueItemIDs []string) ([]models.MusicTrack, error) {
	if len(queueItemIDs) != len(queue) {
		return nil, fmt.Errorf("%w: queue item set mismatch", pkg.ErrBadRequest)
	}
	byID := make(map[string]models.MusicTrack, len(queue))
	for _, track := range queue {
		byID[track.QueueItemID] = track
	}
	reordered := make([]models.MusicTrack, 0, len(queue))
	for _, id := range queueItemIDs {
		track, ok := byID[id]
		if !ok {
			return nil, fmt.Errorf("%w: queue item set mismatch", pkg.ErrBadRequest)
		}
		delete(byID, id)
		reordered = append(reordered, track)
	}
	if len(byID) != 0 {
		return nil, fmt.Errorf("%w: duplicate queue item", pkg.ErrBadRequest)
	}
	return reordered, nil
}
