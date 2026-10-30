package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"sync"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/google/uuid"
)

var ErrMusicProtocolRequired = fmt.Errorf("music protocol 2 metadata required")

type MusicCommand struct {
	// BeforeNewWork applies resource budgets after durable retries are checked.
	// This trusted callback is excluded from the request payload and digest.
	BeforeNewWork       func() error `json:"-"`
	SessionID           string       `json:"session_id"`
	RequestID           string       `json:"request_id"`
	ExpectedRevision    *uint64      `json:"expected_revision"`
	ExpectedQueueItemID *string      `json:"expected_queue_item_id,omitempty"`
	Action              string       `json:"-"`
	URL                 string       `json:"url,omitempty"`
	QueueItemID         string       `json:"queue_item_id,omitempty"`
	QueueItemIDs        []string     `json:"queue_item_ids,omitempty"`
	Mode                string       `json:"mode,omitempty"`
	Seconds             int          `json:"seconds,omitempty"`
}

type GuardedMusicBotService interface {
	AdoptControl(context.Context, string) (models.MusicControlHead, error)
	ApplyMusicCommand(context.Context, string, string, MusicCommand) (json.RawMessage, error)
	CheckLegacyControl(context.Context, string) error
}

// ErrorAwareMusicState preserves the legacy in-process interface while HTTP
// distinguishes genuine inactive state from a failed durable-head lookup.
type ErrorAwareMusicState interface {
	GetStateWithError(context.Context, string) (*models.MusicBotChannelState, error)
}

type musicControlStore interface {
	MusicControlHead(context.Context, string) (*models.MusicControlHead, error)
	AdoptMusicControl(context.Context, models.MusicControlHead) (models.MusicControlHead, error)
	FindMusicReceipt(context.Context, models.MusicOperation) (*models.MusicOperationReceipt, error)
	CommitMusicOperation(context.Context, models.MusicOperationCommit) (models.MusicOperationReceipt, bool, error)
	SaveMusicTransition(context.Context, models.MusicControlHead, *models.MusicSession) error
}

type musicCommandContextKey struct{}
type musicReconnectContextKey struct{}
type musicPendingCommand struct {
	operation models.MusicOperation
	result    json.RawMessage
}

// Striped request locks join concurrent identical retries without serializing
// unrelated commands for an entire channel across slow network extraction.
type musicRequestLock struct {
	mu   sync.Mutex
	refs int
}

var musicRequestLocks struct {
	mu      sync.Mutex
	entries map[[32]byte]*musicRequestLock
}

// Only identical request identities wait for one another. A short hash stripe
// held across extraction would also block an unrelated stop on a collision.
func lockMusicRequest(key [32]byte) func() {
	musicRequestLocks.mu.Lock()
	if musicRequestLocks.entries == nil {
		musicRequestLocks.entries = make(map[[32]byte]*musicRequestLock)
	}
	entry := musicRequestLocks.entries[key]
	if entry == nil {
		entry = &musicRequestLock{}
		musicRequestLocks.entries[key] = entry
	}
	entry.refs++
	musicRequestLocks.mu.Unlock()
	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		musicRequestLocks.mu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(musicRequestLocks.entries, key)
		}
		musicRequestLocks.mu.Unlock()
	}
}

func (s *musicBotService) controlStore() (musicControlStore, error) {
	store, ok := s.sessions.(musicControlStore)
	if !ok {
		return nil, fmt.Errorf("music protocol store unavailable")
	}
	return store, nil
}

func (s *musicBotService) CheckLegacyControl(ctx context.Context, channelID string) error {
	store, ok := s.sessions.(musicControlStore)
	if !ok {
		return nil
	}
	head, err := store.MusicControlHead(ctx, channelID)
	if err != nil {
		return err
	}
	if head != nil {
		return ErrMusicProtocolRequired
	}
	return nil
}

func (s *musicBotService) AdoptControl(ctx context.Context, channelID string) (models.MusicControlHead, error) {
	store, err := s.controlStore()
	if err != nil {
		return models.MusicControlHead{}, err
	}
	channel, err := s.channels.GetByID(ctx, channelID)
	if err != nil {
		return models.MusicControlHead{}, err
	}
	if channel.Type != models.ChannelTypeVoice {
		return models.MusicControlHead{}, pkg.ErrBadRequest
	}
	lock := s.channelLifecycleLock(channelID)
	lock.Lock()
	defer lock.Unlock()
	bot := s.lookupBot(channelID)
	if bot != nil {
		bot.sessionMu.Lock()
		defer bot.sessionMu.Unlock()
	}
	head := models.MusicControlHead{ChannelID: channelID, ServerID: channel.ServerID, SessionID: uuid.NewString(), MinimumProtocol: 2}
	if bot != nil {
		bot.mu.Lock()
		head.Revision = bot.revision
		bot.mu.Unlock()
	} else {
		s.mu.RLock()
		head.Revision = s.restored[channelID].Revision
		s.mu.RUnlock()
	}
	head, err = store.AdoptMusicControl(ctx, head)
	if err != nil {
		return head, err
	}
	if bot != nil {
		bot.mu.Lock()
		bot.sessionID = head.SessionID
		bot.mu.Unlock()
	}
	s.mu.Lock()
	if old, ok := s.restored[channelID]; ok {
		old.SessionID = head.SessionID
		s.restored[channelID] = old
	}
	s.mu.Unlock()
	return head, nil
}

func (s *musicBotService) ApplyMusicCommand(ctx context.Context, actorID, channelID string, command MusicCommand) (json.RawMessage, error) {
	if command.SessionID == "" || command.RequestID == "" || command.ExpectedRevision == nil {
		return nil, ErrMusicProtocolRequired
	}
	if *command.ExpectedRevision >= math.MaxInt64 {
		return nil, pkg.ErrBadRequest
	}
	if _, err := uuid.Parse(command.SessionID); err != nil {
		return nil, pkg.ErrBadRequest
	}
	if _, err := uuid.Parse(command.RequestID); err != nil {
		return nil, pkg.ErrBadRequest
	}
	store, err := s.controlStore()
	if err != nil {
		return nil, err
	}
	canonical, err := json.Marshal(struct {
		Action  string
		Command MusicCommand
	}{command.Action, command})
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(canonical)
	op := models.MusicOperation{ActorID: actorID, ChannelID: channelID, SessionID: command.SessionID, RequestID: command.RequestID, ExpectedRevision: *command.ExpectedRevision, RequestHash: hex.EncodeToString(digest[:])}
	key := sha256.Sum256([]byte(actorID + "\x00" + channelID + "\x00" + command.RequestID))
	unlock := lockMusicRequest(key)
	defer unlock()
	if receipt, err := store.FindMusicReceipt(ctx, op); err != nil {
		return nil, err
	} else if receipt != nil {
		return receipt.Result, nil
	}
	head, err := store.MusicControlHead(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if head == nil {
		return nil, ErrMusicProtocolRequired
	}
	if head.SessionID != op.SessionID || head.Revision != op.ExpectedRevision {
		return nil, pkg.ErrConflict
	}
	if err := RecheckMusicAccess(ctx); err != nil {
		return nil, err
	}
	if command.BeforeNewWork != nil {
		if err := command.BeforeNewWork(); err != nil {
			return nil, err
		}
	}
	if command.Action == "play" {
		pending := &musicPendingCommand{operation: op}
		_, err := s.Enqueue(context.WithValue(ctx, musicCommandContextKey{}, pending), actorID, channelID, command.URL)
		return pending.result, err
	}
	return s.applyImmediateMusicCommand(ctx, store, *head, op, command)
}

// persistEnqueue is called with the live bot session lock held. Its receipt and
// queue snapshot commit together; failed extraction/connect never writes one.
func (s *musicBotService) persistEnqueue(ctx context.Context, bot *botInstance, tracks []models.MusicTrack, actor string, mayHaveSkippedTracks bool) error {
	if err := RecheckMusicAccess(ctx); err != nil {
		return err
	}
	pending, _ := ctx.Value(musicCommandContextKey{}).(*musicPendingCommand)
	if pending == nil {
		if err := s.CheckLegacyControl(ctx, bot.channelID); err != nil {
			return err
		}
		if writer, ok := s.sessions.(musicLegacyEnqueueStore); ok {
			if err := writer.SaveMusicEnqueue(ctx, s.sessionSnapshot(bot), actor); err != nil {
				return err
			}
			s.refreshMusicRequesterCache(bot)
			return nil
		}
		return s.persistBot(bot)
	}
	store, err := s.controlStore()
	if err != nil {
		return err
	}
	session := s.sessionSnapshot(bot)
	if session.SessionID != pending.operation.SessionID {
		return pkg.ErrConflict
	}
	result, _ := json.Marshal(struct {
		AddedTracks          []models.MusicTrack `json:"added_tracks"`
		MayHaveSkippedTracks bool                `json:"may_have_skipped_tracks,omitempty"`
	}{AddedTracks: tracks, MayHaveSkippedTracks: mayHaveSkippedTracks})
	head := models.MusicControlHead{ChannelID: bot.channelID, ServerID: bot.serverID, SessionID: session.SessionID, Revision: session.Revision, MinimumProtocol: 2}
	receipt, replayed, err := store.CommitMusicOperation(ctx, models.MusicOperationCommit{Operation: pending.operation, NextHead: head, Session: &session, Result: result})
	if err != nil {
		return err
	}
	if replayed {
		return pkg.ErrConflict
	} // outer request lock prevents this; never duplicate side effects.
	pending.result = receipt.Result
	s.refreshMusicRequesterCache(bot)
	return nil
}

func (s *musicBotService) applyImmediateMusicCommand(ctx context.Context, store musicControlStore, head models.MusicControlHead, op models.MusicOperation, command MusicCommand) (json.RawMessage, error) {
	lifecycle := s.channelLifecycleLock(op.ChannelID)
	// Restore connects without holding the lifecycle stripe, so an explicit
	// concurrent stop still wins. It does not start playback before its commit.
	var bot *botInstance
	var err error
	if command.Action == "restore" {
		s.mu.RLock()
		_, exists := s.restored[op.ChannelID]
		s.mu.RUnlock()
		if !exists {
			return nil, pkg.ErrNotFound
		}
		bot, err = s.getOrCreateBot(ctx, head.ServerID, op.ChannelID)
		if err != nil {
			return nil, err
		}
	}
	if err := RecheckMusicAccess(ctx); err != nil {
		if bot != nil {
			s.cleanupMusicAttemptBot(ctx, bot)
		}
		return nil, err
	}
	lifecycle.Lock()
	defer lifecycle.Unlock()
	if bot == nil {
		bot = s.lookupBot(op.ChannelID)
	}
	if bot == nil && (command.Action == "remove" || command.Action == "reorder") {
		return s.editRestoredMusicQueue(ctx, store, head, op, command)
	}
	if bot != nil {
		bot.sessionMu.Lock()
		defer bot.sessionMu.Unlock()
	}
	if err := RecheckMusicAccess(ctx); err != nil {
		if bot != nil {
			s.cleanupMusicAttemptBotLocked(ctx, bot)
		}
		return nil, err
	}
	if bot != nil {
		bot.mu.Lock()
	}
	if bot != nil && (bot.stopping.Load() || bot.sessionID != op.SessionID || bot.revision != op.ExpectedRevision) {
		bot.mu.Unlock()
		return nil, pkg.ErrConflict
	}
	if bot == nil && command.Action != "stop" {
		return nil, pkg.ErrNotFound
	}
	if command.Action == "skip" || command.Action == "seek" || command.Action == "pause" || command.Action == "resume" {
		current := ""
		if bot.currentTrack != nil {
			current = bot.currentTrack.QueueItemID
		}
		if command.ExpectedQueueItemID == nil || *command.ExpectedQueueItemID != current {
			bot.mu.Unlock()
			return nil, pkg.ErrConflict
		}
	}
	var next models.MusicSession
	if bot != nil {
		next = models.MusicSession{ChannelID: bot.channelID, ServerID: bot.serverID, SessionID: bot.sessionID, Revision: bot.revision + 1, RepeatMode: bot.repeatMode, Queue: cloneMusicTracks(bot.queue)}
		if next.RepeatMode == "" {
			next.RepeatMode = "off"
		}
	}
	var apply func()
	startLoop := false
	switch command.Action {
	case "stop":
		head.SessionID = uuid.NewString()
	case "skip":
		apply = func() {
			bot.skipFlag = true
			if bot.cancelFn != nil {
				bot.cancelFn()
			}
			if bot.cmd != nil && bot.cmd.Process != nil {
				_ = bot.cmd.Process.Kill()
			}
		}
	case "pause", "resume":
		pause := command.Action == "pause"
		apply = func() { bot.isPaused = pause }
	case "seek":
		if bot.currentTrack == nil || bot.currentTrack.DurationSeconds <= 0 || command.Seconds < 0 || command.Seconds >= bot.currentTrack.DurationSeconds {
			bot.mu.Unlock()
			return nil, pkg.ErrBadRequest
		}
		apply = func() {
			bot.seekTarget = time.Duration(command.Seconds) * time.Second
			bot.seekRequested = true
			if bot.cancelFn != nil {
				bot.cancelFn()
			}
			if bot.cmd != nil && bot.cmd.Process != nil {
				_ = bot.cmd.Process.Kill()
			}
		}
	case "repeat":
		if command.Mode != "off" && command.Mode != "one" && command.Mode != "all" {
			bot.mu.Unlock()
			return nil, pkg.ErrBadRequest
		}
		next.RepeatMode = command.Mode
		apply = func() { bot.repeatMode = command.Mode }
	case "remove":
		index := -1
		for i, t := range next.Queue {
			if t.QueueItemID == command.QueueItemID {
				index = i
				break
			}
		}
		if index < 0 {
			bot.mu.Unlock()
			return nil, pkg.ErrNotFound
		}
		next.Queue = append(next.Queue[:index], next.Queue[index+1:]...)
		apply = func() { bot.queue = next.Queue }
	case "reorder":
		if len(command.QueueItemIDs) != len(next.Queue) || len(command.QueueItemIDs) > maxQueueLen {
			bot.mu.Unlock()
			return nil, pkg.ErrBadRequest
		}
		byID := map[string]models.MusicTrack{}
		for _, t := range next.Queue {
			byID[t.QueueItemID] = t
		}
		ordered := make([]models.MusicTrack, 0, len(next.Queue))
		for _, id := range command.QueueItemIDs {
			t, ok := byID[id]
			if !ok {
				bot.mu.Unlock()
				return nil, pkg.ErrBadRequest
			}
			ordered = append(ordered, t)
			delete(byID, id)
		}
		next.Queue = ordered
		apply = func() { bot.queue = next.Queue }
	case "shuffle":
		rand.Shuffle(len(next.Queue), func(i, j int) { next.Queue[i], next.Queue[j] = next.Queue[j], next.Queue[i] }) // #nosec G404 -- non-security playback order
		apply = func() { bot.queue = next.Queue }
	case "restore":
		startLoop = !bot.loopRunning
		apply = func() { bot.loopRunning = true; bot.isPaused = false }
	default:
		if bot != nil {
			bot.mu.Unlock()
		}
		return nil, pkg.ErrBadRequest
	}
	if bot != nil {
		// Paused restart persistence always includes the interrupted current
		// track, except skip: the skipped item must not reappear after restart.
		if bot.currentTrack != nil && command.Action != "skip" {
			next.Queue = append([]models.MusicTrack{*bot.currentTrack}, next.Queue...)
		}
		bot.mu.Unlock()
	}
	head.Revision = op.ExpectedRevision + 1
	var persisted *models.MusicSession
	if command.Action != "stop" && len(next.Queue) > 0 {
		persisted = &next
	}
	result := json.RawMessage(`{"status":"ok"}`)
	if err := RecheckMusicAccess(ctx); err != nil {
		if bot != nil {
			s.cleanupMusicAttemptBotLocked(ctx, bot)
		}
		return nil, err
	}
	receipt, replayed, err := store.CommitMusicOperation(ctx, models.MusicOperationCommit{Operation: op, NextHead: head, Session: persisted, Result: result})
	if err != nil {
		if bot != nil {
			s.cleanupMusicAttemptBotLocked(ctx, bot)
		}
		return nil, err
	}
	if replayed {
		return receipt.Result, nil
	}
	if command.Action == "stop" {
		s.mu.Lock()
		delete(s.restored, op.ChannelID)
		s.mu.Unlock()
		if bot != nil {
			bot.explicitStop.Store(true)
			s.stopBotLocked(bot)
		}
		return receipt.Result, nil
	}
	bot.mu.Lock()
	bot.revision = head.Revision
	// Restore only assigns the pending queue; persistent current-track prefix
	// above must not be copied into the live pending queue by reorder/remove.
	if command.Action == "remove" || command.Action == "reorder" || command.Action == "shuffle" {
		if bot.currentTrack != nil {
			next.Queue = next.Queue[1:]
		}
	}
	if apply != nil {
		apply()
	}
	bot.mu.Unlock()
	s.refreshMusicRequesterCache(bot)
	if command.Action == "restore" {
		s.mu.Lock()
		delete(s.restored, op.ChannelID)
		s.mu.Unlock()
	}
	if startLoop {
		go s.playLoop(bot)
	}
	s.broadcastState(bot)
	return receipt.Result, nil
}
