package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"testing"
)

type enqueueSelectionStore struct {
	MusicSessionStore
	ordinary, guarded int
	failure           error
}

func (s *enqueueSelectionStore) Save(context.Context, models.MusicSession) error {
	s.ordinary++
	return nil
}
func (s *enqueueSelectionStore) SaveMusicEnqueue(context.Context, models.MusicSession, string) error {
	s.guarded++
	return s.failure
}
func TestMusicLegacyEnqueueExplicitSelectionAndFailure(t *testing.T) {
	service := newTestMusicBotService("ch", "srv")
	sentinel := errors.New("guarded enqueue unavailable")
	store := &enqueueSelectionStore{failure: sentinel}
	service.sessions = store
	bot := service.bots["ch"]
	if err := service.persistEnqueue(context.Background(), bot, nil, "actor", false); err != nil {
		t.Fatal(err)
	}
	if store.ordinary != 1 || store.guarded != 0 {
		t.Fatalf("disabled selection rediscovered guarded writer: %+v", store)
	}
	service.legacyEnqueue = store
	if err := service.persistEnqueue(context.Background(), bot, nil, "actor", false); !errors.Is(err, sentinel) {
		t.Fatalf("guarded failure=%v", err)
	}
	if store.ordinary != 1 || store.guarded != 1 {
		t.Fatalf("guarded failure fell back: %+v", store)
	}
}
