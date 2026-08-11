package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

func newTestSoundboardService(
	repo *testutil.MockSoundboardRepo,
	uploadDir string,
) SoundboardService {
	return NewSoundboardService(
		repo,
		&testutil.MockUserRepo{},
		&testutil.MockBroadcaster{},
		&testutil.MockVoiceStateGetter{},
		uploadDir,
		10*1024*1024,
	)
}

// ─── Cross-tenant IDOR: sound belongs to a different server (H-04) ───
//
// Regression guard for the BOLA where Update/Delete trusted the path's
// soundId without ever checking it against the path's serverId — a caller
// with ManageSoundboard on server A could edit/delete a sound belonging to
// server B by guessing/observing its soundID.

func TestSoundboardUpdateCrossServer(t *testing.T) {
	var updateCalled bool
	repo := &testutil.MockSoundboardRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.SoundboardSound, error) {
			return &models.SoundboardSound{ID: "s1", ServerID: "other-srv"}, nil
		},
		UpdateFn: func(_ context.Context, _ *models.SoundboardSound) error {
			updateCalled = true
			return nil
		},
	}
	svc := newTestSoundboardService(repo, t.TempDir())

	newName := "renamed"
	_, err := svc.Update(context.Background(), "srv1", "s1", &models.UpdateSoundboardSoundRequest{Name: &newName})
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("Update cross-server: expected ErrNotFound, got %v", err)
	}
	if updateCalled {
		t.Error("the sound must not be written when it belongs to a different server")
	}
}

func TestSoundboardDeleteCrossServer(t *testing.T) {
	dir := t.TempDir()
	soundDir := filepath.Join(dir, "soundboard")
	if err := os.MkdirAll(soundDir, 0o750); err != nil {
		t.Fatalf("failed to prepare sound dir: %v", err)
	}
	diskPath := filepath.Join(soundDir, "clip.wav")
	if err := os.WriteFile(diskPath, []byte("fake audio"), 0o640); err != nil {
		t.Fatalf("failed to write fixture file: %v", err)
	}

	var deleteCalled bool
	repo := &testutil.MockSoundboardRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.SoundboardSound, error) {
			return &models.SoundboardSound{ID: "s1", ServerID: "other-srv", FileURL: "/api/uploads/soundboard/clip.wav"}, nil
		},
		DeleteFn: func(_ context.Context, _ string) error {
			deleteCalled = true
			return nil
		},
	}
	svc := newTestSoundboardService(repo, dir)

	err := svc.Delete(context.Background(), "srv1", "s1")
	if !errors.Is(err, pkg.ErrNotFound) {
		t.Errorf("Delete cross-server: expected ErrNotFound, got %v", err)
	}
	if deleteCalled {
		t.Error("the repo record must not be deleted when the sound belongs to a different server")
	}
	if _, statErr := os.Stat(diskPath); statErr != nil {
		t.Errorf("the audio file must still exist on disk after a rejected cross-server delete, stat err: %v", statErr)
	}
}

// ─── Happy paths: existing behavior preserved once the scope check passes ───

func TestSoundboardUpdateHappyPath(t *testing.T) {
	var updateCalled bool
	// current models the row backing the repo: Update() writes it, GetByID()
	// reads a fresh copy so the service's post-write re-fetch (line "updated,
	// _ := s.repo.GetByID(...)") observes the write, matching real repo semantics.
	current := &models.SoundboardSound{ID: "s1", ServerID: "srv1", Name: "old"}
	repo := &testutil.MockSoundboardRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.SoundboardSound, error) {
			cp := *current
			return &cp, nil
		},
		UpdateFn: func(_ context.Context, sound *models.SoundboardSound) error {
			updateCalled = true
			if sound.Name != "renamed" {
				t.Errorf("expected updated name 'renamed', got %q", sound.Name)
			}
			current = sound
			return nil
		},
	}
	svc := newTestSoundboardService(repo, t.TempDir())

	newName := "renamed"
	updated, err := svc.Update(context.Background(), "srv1", "s1", &models.UpdateSoundboardSoundRequest{Name: &newName})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !updateCalled {
		t.Error("expected repo Update to be called")
	}
	if updated.Name != "renamed" {
		t.Errorf("unexpected updated sound: %+v", updated)
	}
}

func TestSoundboardDeleteHappyPath(t *testing.T) {
	dir := t.TempDir()
	soundDir := filepath.Join(dir, "soundboard")
	if err := os.MkdirAll(soundDir, 0o750); err != nil {
		t.Fatalf("failed to prepare sound dir: %v", err)
	}
	diskPath := filepath.Join(soundDir, "clip.wav")
	if err := os.WriteFile(diskPath, []byte("fake audio"), 0o640); err != nil {
		t.Fatalf("failed to write fixture file: %v", err)
	}

	var deleteCalled bool
	repo := &testutil.MockSoundboardRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.SoundboardSound, error) {
			return &models.SoundboardSound{ID: "s1", ServerID: "srv1", FileURL: "/api/uploads/soundboard/clip.wav"}, nil
		},
		DeleteFn: func(_ context.Context, _ string) error {
			deleteCalled = true
			return nil
		},
	}
	svc := newTestSoundboardService(repo, dir)

	if err := svc.Delete(context.Background(), "srv1", "s1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !deleteCalled {
		t.Error("expected repo Delete to be called")
	}
	if _, statErr := os.Stat(diskPath); !os.IsNotExist(statErr) {
		t.Errorf("expected the audio file to be removed from disk, stat err: %v", statErr)
	}
}
