package services

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type preferencesRepoStub struct {
	prefs  *models.UserPreferences
	err    error
	patch  json.RawMessage
	userID string
	writes int
}

func (s *preferencesRepoStub) Get(_ context.Context, userID string) (*models.UserPreferences, error) {
	s.userID = userID
	return s.prefs, s.err
}
func (s *preferencesRepoStub) Upsert(_ context.Context, userID string, patch json.RawMessage) (*models.UserPreferences, error) {
	s.writes++
	s.userID, s.patch = userID, patch
	if s.err != nil {
		return nil, s.err
	}
	if s.prefs != nil {
		return s.prefs, nil
	}
	return &models.UserPreferences{UserID: userID, Data: patch}, nil
}

func TestPreferencesServiceValidatesBeforeWriting(t *testing.T) {
	for _, patch := range []string{`null`, `[]`, `{"voice_settings":{"masterVolume":101}}`, `{"unknown":true}`} {
		repo := &preferencesRepoStub{}
		prefs, err := NewPreferencesService(repo).Update(context.Background(), "user-1", json.RawMessage(patch))
		if !errors.Is(err, pkg.ErrBadRequest) || prefs != nil || repo.writes != 0 {
			t.Fatalf("invalid update returned success or wrote: prefs=%v err=%v writes=%d", prefs, err, repo.writes)
		}
	}
}

func TestPreferencesServiceStripsLocalFieldsAndVersionsResponse(t *testing.T) {
	repo := &preferencesRepoStub{}
	svc := NewPreferencesService(repo)
	prefs, err := svc.Update(context.Background(), "user-1", json.RawMessage(`{"voice_settings":{"inputDevice":"device-secret","outputDevice":"device-secret","cameraDevice":"device-secret","muteHotkeyGlobal":true,"masterVolume":70}}`))
	if err != nil {
		t.Fatal(err)
	}
	if repo.userID != "user-1" || repo.writes != 1 || strings.Contains(string(repo.patch), "device-secret") || strings.Contains(string(repo.patch), "muteHotkeyGlobal") {
		t.Fatalf("incorrect write: %s", repo.patch)
	}
	if prefs.SchemaVersion != 1 || string(prefs.Data) != `{"voice_settings":{"masterVolume":70}}` {
		t.Fatalf("incorrect response: %+v", prefs)
	}
	repo.prefs = &models.UserPreferences{UserID: "user-1", Data: json.RawMessage(`{"legacy":true,"voice_settings":{"cameraDevice":"secret","masterVolume":80}}`)}
	prefs, err = svc.Get(context.Background(), "user-1")
	if err != nil || prefs.SchemaVersion != 1 || strings.Contains(string(prefs.Data), "secret") || !strings.Contains(string(prefs.Data), "legacy") {
		t.Fatalf("incorrect read: %+v %v", prefs, err)
	}
	if repo.prefs.SchemaVersion != 0 || !strings.Contains(string(repo.prefs.Data), "secret") {
		t.Fatal("normalization mutated repository-owned data")
	}
}

func TestPreferencesServiceDoesNotMaskDatabaseFailures(t *testing.T) {
	failure := errors.New("database unavailable")
	repo := &preferencesRepoStub{err: failure}
	svc := NewPreferencesService(repo)
	if prefs, err := svc.Get(context.Background(), "user-1"); prefs != nil || !errors.Is(err, failure) {
		t.Fatalf("Get failure masked: %+v %v", prefs, err)
	}
	if prefs, err := svc.Update(context.Background(), "user-1", json.RawMessage(`{"theme":"ocean"}`)); prefs != nil || !errors.Is(err, failure) {
		t.Fatalf("Update failure masked: %+v %v", prefs, err)
	}
	repo.err = nil
	if prefs, err := svc.Get(context.Background(), "user-1"); prefs != nil || err == nil {
		t.Fatal("nil repository result returned success")
	}
	repo.prefs = &models.UserPreferences{Data: json.RawMessage(`null`)}
	if prefs, err := svc.Get(context.Background(), "user-1"); prefs != nil || err == nil {
		t.Fatal("corrupt repository result returned success")
	}
}

func TestPreferencesServiceMigratesHiddenNoiseEnginesOnReadAndWrite(t *testing.T) {
	for _, engine := range []string{"krisp", "dpdfnet"} {
		t.Run(engine, func(t *testing.T) {
			repo := &preferencesRepoStub{}
			svc := NewPreferencesService(repo)
			legacy := json.RawMessage(`{"voice_settings":{"noiseReductionEngine":"` + engine + `","masterVolume":70}}`)
			prefs, err := svc.Update(context.Background(), "user-1", legacy)
			if err != nil {
				t.Fatal(err)
			}
			want := `{"voice_settings":{"masterVolume":70,"noiseReductionEngine":"rnnoise"}}`
			if string(repo.patch) != want || string(prefs.Data) != want {
				t.Fatalf("hidden engine survived write: patch=%s response=%s", repo.patch, prefs.Data)
			}
			repo.prefs = &models.UserPreferences{UserID: "user-1", Data: legacy}
			prefs, err = svc.Get(context.Background(), "user-1")
			if err != nil || string(prefs.Data) != want {
				t.Fatalf("hidden engine survived read: prefs=%v err=%v", prefs, err)
			}
			if string(repo.prefs.Data) != string(legacy) {
				t.Fatal("read normalization mutated repository-owned data")
			}
		})
	}
}
