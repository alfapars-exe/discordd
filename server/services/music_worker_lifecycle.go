package services

import (
	"context"

	"github.com/argeinfina/hichat/pkg/logx"
)

// Register before launch under the same mutex that closes terminal admission.
// All accepted work is retained even after its bot leaves the current map.
func (s *musicBotService) beginMusicWork(parent context.Context) (context.Context, func(), bool) {
	s.mu.Lock()
	if s.shuttingDown {
		s.mu.Unlock()
		return nil, nil, false
	}
	if s.musicWorkCancel == nil {
		s.musicWorkCtx, s.musicWorkCancel = context.WithCancel(context.Background())
	}
	owner := s.musicWorkCtx
	s.musicWork.Add(1)
	s.mu.Unlock()
	ctx, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(owner, cancel)
	return ctx, func() { stop(); cancel(); s.musicWork.Done() }, true
}

func (s *musicBotService) launchMusicWorker(name string, work func()) {
	_, finish, accepted := s.beginMusicWork(context.Background())
	if !accepted {
		return
	}
	go func() { defer finish(); logx.Run(name, work) }()
}
