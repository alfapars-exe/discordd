package services

import (
	"context"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/ws"
)

const deletedMusicRequesterName = "Deleted User"

type musicRequesterPrivacyStore interface {
	SanitizeMusicTracks(context.Context, []models.MusicTrack) ([]models.MusicTrack, error)
}
type musicLegacyEnqueueStore interface {
	SaveMusicEnqueue(context.Context, models.MusicSession, string) error
}

// The publication read fence spans HTTP serialization, not only copying.
type PublicMusicStateReader interface {
	WithPublicMusicState(context.Context, string, func(*models.MusicBotChannelState)) error
}
type MusicRequesterRetirementObserver interface{ AnonymizeMusicRequester(string) }

func (s *musicBotService) sanitizeMusicState(ctx context.Context, state *models.MusicBotChannelState) (*models.MusicBotChannelState, error) {
	if state == nil {
		return nil, nil
	}
	store, ok := s.sessions.(musicRequesterPrivacyStore)
	if !ok {
		return state, nil
	}
	all := append([]models.MusicTrack(nil), state.Queue...)
	if state.CurrentTrack != nil {
		all = append(all, *state.CurrentTrack)
	}
	cleaned, err := store.SanitizeMusicTracks(ctx, all)
	if err != nil {
		return nil, err
	}
	copy := *state
	copy.Queue = append([]models.MusicTrack{}, cleaned[:len(state.Queue)]...)
	if state.CurrentTrack != nil {
		track := cleaned[len(cleaned)-1]
		copy.CurrentTrack = &track
	}
	return &copy, nil
}

func (s *musicBotService) WithPublicMusicState(ctx context.Context, channelID string, consume func(*models.MusicBotChannelState)) error {
	ctx, cancel := context.WithTimeout(ctx, sessionRepoTimeout)
	defer cancel()
	s.musicPublicationMu.RLock()
	defer s.musicPublicationMu.RUnlock()
	state, err := s.rawMusicState(ctx, channelID)
	if err != nil {
		return err
	}
	state, err = s.sanitizeMusicState(ctx, state)
	if err != nil {
		return err
	}
	consume(state)
	return nil
}

func stripMusicRequester(tracks []models.MusicTrack, id string) bool {
	matched := false
	for i := range tracks {
		if tracks[i].RequestedByUserID == id {
			tracks[i].RequestedByName = deletedMusicRequesterName
			matched = true
		}
	}
	// Presence matters even if another writer already sanitized the cache:
	// an older in-flight publication still needs a fenced replacement event.
	return matched
}

// Called with sessionMu after a durable write. A lookup failure cannot undo an
// already committed queue; subsequent public snapshots fail closed instead.
func (s *musicBotService) refreshMusicRequesterCache(bot *botInstance) {
	ctx, cancel := context.WithTimeout(context.Background(), sessionRepoTimeout)
	defer cancel()
	bot.mu.Lock()
	snapshot := bot.snapshotLocked()
	bot.mu.Unlock()
	cleaned, err := s.sanitizeMusicState(ctx, snapshot)
	if err != nil {
		musicBotLogger.Error("refresh music requester privacy", "err", pkg.ErrText(err))
		return
	}
	bot.mu.Lock()
	defer bot.mu.Unlock()
	for i := range bot.queue {
		if i < len(cleaned.Queue) && bot.queue[i].QueueItemID == cleaned.Queue[i].QueueItemID {
			bot.queue[i].RequestedByName = cleaned.Queue[i].RequestedByName
		}
	}
	if bot.currentTrack != nil && cleaned.CurrentTrack != nil && bot.currentTrack.QueueItemID == cleaned.CurrentTrack.QueueItemID {
		bot.currentTrack.RequestedByName = cleaned.CurrentTrack.RequestedByName
	}
}

func (s *musicBotService) publishMusicState(serverID, channelID string, state *models.MusicBotChannelState, final bool) bool {
	var payload any = state
	if final && state != nil {
		payload = *state
	}
	return s.broadcastMusicAudience(serverID, channelID, ws.Event{Op: "music_bot_state", Data: map[string]any{"channel_id": channelID, "server_id": serverID, "state": payload}})
}

func (s *musicBotService) broadcastPrivateMusicState(bot *botInstance, final bool) {
	s.broadcastPrivateMusicStateConditional(bot, final, false)
}

func (s *musicBotService) broadcastPrivateMusicStateConditional(bot *botInstance, final, onlyIfPublishedActive bool) {
	s.musicPublicationMu.RLock()
	defer s.musicPublicationMu.RUnlock()
	bot.publicationMu.Lock()
	defer bot.publicationMu.Unlock()
	if onlyIfPublishedActive && !bot.publishedActive.Load() {
		return
	}
	// An old attempt must never reconcile over a replacement publisher.
	if current := s.lookupBot(bot.channelID); current != nil && current != bot {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), sessionRepoTimeout)
	defer cancel()
	var state *models.MusicBotChannelState
	var err error
	if final {
		state, err = s.rawMusicState(ctx, bot.channelID)
		if state == nil && err == nil {
			state = &models.MusicBotChannelState{ChannelID: bot.channelID, ServerID: bot.serverID, Queue: []models.MusicTrack{}}
		}
	} else {
		bot.mu.Lock()
		state = bot.snapshotLocked()
		bot.mu.Unlock()
		if bot.stopping.Load() {
			return
		}
	}
	if err == nil {
		state, err = s.sanitizeMusicState(ctx, state)
	}
	if err != nil {
		musicBotLogger.Error("read music snapshot privacy", "err", pkg.ErrText(err))
		return
	}
	if s.publishMusicState(bot.serverID, bot.channelID, state, final) && state != nil && state.IsActive {
		bot.publishedActive.Store(true)
	}
}

// Lock order: sessionMu -> mu for cache edits, releasing both; then publication
// WLock -> mu for delivery. Never take sessionMu with publication WLock held:
// controls may publish under sessionMu. WLock drains older GET/WS deliveries
// before replacement, so an equal queue revision cannot resurrect an old name.
func (s *musicBotService) AnonymizeMusicRequester(id string) {
	if id == "" {
		return
	}
	s.mu.RLock()
	bots := make([]*botInstance, 0, len(s.bots))
	for _, bot := range s.bots {
		bots = append(bots, bot)
	}
	s.mu.RUnlock()
	affected := map[string]string{}
	for _, bot := range bots {
		bot.sessionMu.Lock()
		bot.mu.Lock()
		changed := stripMusicRequester(bot.queue, id)
		if bot.currentTrack != nil && bot.currentTrack.RequestedByUserID == id {
			bot.currentTrack.RequestedByName = deletedMusicRequesterName
			changed = true
		}
		if bot.user != nil && bot.user.userID == id {
			bot.user.name = deletedMusicRequesterName
			changed = true
		}
		if changed {
			affected[bot.channelID] = bot.serverID
		}
		bot.mu.Unlock()
		bot.sessionMu.Unlock()
	}
	s.mu.Lock()
	for channel, session := range s.restored {
		session.Queue = cloneMusicTracks(session.Queue)
		if stripMusicRequester(session.Queue, id) {
			s.restored[channel] = session
			affected[channel] = session.ServerID
		}
	}
	s.mu.Unlock()
	s.musicPublicationMu.Lock()
	defer s.musicPublicationMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), sessionRepoTimeout)
	defer cancel()
	for channel, server := range affected {
		state, err := s.rawMusicState(ctx, channel)
		if err != nil {
			musicBotLogger.Error("publish retired music requester", "err", pkg.ErrText(err))
			continue
		}
		if state == nil {
			continue
		}
		stripMusicRequester(state.Queue, id)
		if state.CurrentTrack != nil && state.CurrentTrack.RequestedByUserID == id {
			state.CurrentTrack.RequestedByName = deletedMusicRequesterName
		}
		state, err = s.sanitizeMusicState(ctx, state)
		if err != nil {
			musicBotLogger.Error("sanitize retired music publication", "err", pkg.ErrText(err))
			continue
		}
		if s.publishMusicState(server, channel, state, false) && state.IsActive {
			if bot := s.lookupBot(channel); bot != nil {
				bot.publishedActive.Store(true)
			}
		}
	}
}
