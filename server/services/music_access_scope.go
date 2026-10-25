package services

import (
	"context"
	"sync"

	"github.com/argeinfina/hichat/pkg"
)

type musicAccessScopeKey struct{}
type musicAccessScope struct {
	check   func(context.Context) error
	mu      sync.Mutex
	created *botInstance
}

// WithMusicAccessCheck carries trusted server-side authorization only. No wire
// field can supply/disable this callback, and it is not part of a receipt hash.
func WithMusicAccessCheck(ctx context.Context, check func(context.Context) error) context.Context {
	return context.WithValue(ctx, musicAccessScopeKey{}, &musicAccessScope{check: check})
}

// RecheckMusicAccess is shared by the guarded and legacy enqueue paths. Exact
// receipt replay returns before this new-work check, preserving idempotency.
func RecheckMusicAccess(ctx context.Context) (err error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	scope, _ := ctx.Value(musicAccessScopeKey{}).(*musicAccessScope)
	if scope == nil {
		return nil
	}
	if scope.check == nil {
		return pkg.ErrInternal
	}
	defer func() {
		if recover() != nil {
			musicBotLogger.Error("music access validator panicked")
			err = pkg.ErrInternal
		}
	}()
	bounded, cancel := context.WithTimeout(ctx, sessionRepoTimeout)
	defer cancel()
	return scope.check(bounded)
}

func markMusicAttemptBot(ctx context.Context, bot *botInstance) {
	if scope, ok := ctx.Value(musicAccessScopeKey{}).(*musicAccessScope); ok {
		scope.mu.Lock()
		scope.created = bot
		scope.mu.Unlock()
	}
}

func musicAttemptOwnsBot(ctx context.Context, bot *botInstance) bool {
	scope, _ := ctx.Value(musicAccessScopeKey{}).(*musicAccessScope)
	if scope == nil {
		return false
	}
	scope.mu.Lock()
	defer scope.mu.Unlock()
	return scope.created == bot
}

func (s *musicBotService) cleanupMusicAttemptBot(ctx context.Context, bot *botInstance) {
	if !musicAttemptOwnsBot(ctx, bot) {
		return
	}
	lock := s.channelLifecycleLock(bot.channelID)
	lock.Lock()
	defer lock.Unlock()
	bot.sessionMu.Lock()
	defer bot.sessionMu.Unlock()
	s.cleanupMusicAttemptBotLocked(ctx, bot)
}

// Caller owns lifecycle/session locks, and has rolled back its tentative edit.
// A shared existing bot or a publisher another request has claimed is untouched.
func (s *musicBotService) cleanupMusicAttemptBotLocked(ctx context.Context, bot *botInstance) {
	if !musicAttemptOwnsBot(ctx, bot) {
		return
	}
	bot.mu.Lock()
	unclaimed := bot.currentTrack == nil && !bot.loopRunning
	bot.mu.Unlock()
	if unclaimed {
		s.preserveMusicAttemptRestoredLocked(bot)
		bot.explicitStop.Store(true)
		s.stopBotLockedMode(bot, false)
	}
}

// Session lock is held. Keep legitimate paused-queue edits another actor
// committed while this attempt was connecting; never restore an older cache.
func (s *musicBotService) preserveMusicAttemptRestoredLocked(bot *botInstance) {
	snapshot := s.sessionSnapshot(bot)
	if len(snapshot.Queue) == 0 {
		return
	}
	s.mu.Lock()
	if _, exists := s.restored[bot.channelID]; exists {
		s.restored[bot.channelID] = snapshot
	}
	s.mu.Unlock()
}
