package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

func newUserNoteFixture() (*testutil.MockUserNoteRepo, *testutil.MockUserRepo, UserNoteService) {
	notes := &testutil.MockUserNoteRepo{}
	users := &testutil.MockUserRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
			if id == "ghost" {
				return nil, pkg.ErrNotFound
			}
			return &models.User{ID: id}, nil
		},
	}
	return notes, users, NewUserNoteService(notes, users)
}

func TestUserNoteService_GetEmptyAndStored(t *testing.T) {
	notes, _, svc := newUserNoteFixture()

	got, err := svc.Get(context.Background(), "alice", "bob")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Note != "" || got.UpdatedAt != nil {
		t.Errorf("Get(empty) = %+v, want note \"\" and nil updated_at", got)
	}

	ts := "2026-01-01T00:00:00Z"
	notes.GetFn = func(_ context.Context, owner, target string) (string, *string, error) {
		if owner != "alice" || target != "bob" {
			t.Errorf("Get scoped to (%s, %s), want (alice, bob)", owner, target)
		}
		return "stored", &ts, nil
	}
	got, err = svc.Get(context.Background(), "alice", "bob")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Note != "stored" || got.UpdatedAt == nil || *got.UpdatedAt != ts {
		t.Errorf("Get = %+v", got)
	}
}

func TestUserNoteService_Set(t *testing.T) {
	t.Run("stores the normalised note", func(t *testing.T) {
		notes, _, svc := newUserNoteFixture()
		var stored string
		notes.UpsertFn = func(_ context.Context, owner, target, note string) (string, error) {
			stored = note
			return "2026-02-02T00:00:00Z", nil
		}
		got, err := svc.Set(context.Background(), "alice", "bob", "  likes tea\r\nhates coffee ")
		if err != nil {
			t.Fatalf("Set: %v", err)
		}
		if stored != "likes tea\nhates coffee" || got.Note != stored {
			t.Errorf("stored = %q, response = %+v", stored, got)
		}
		if got.UpdatedAt == nil || *got.UpdatedAt != "2026-02-02T00:00:00Z" {
			t.Errorf("updated_at = %v", got.UpdatedAt)
		}
	})

	t.Run("empty note deletes the row", func(t *testing.T) {
		notes, _, svc := newUserNoteFixture()
		deleted := false
		notes.DeleteFn = func(_ context.Context, _, _ string) error { deleted = true; return nil }
		notes.UpsertFn = func(_ context.Context, _, _, _ string) (string, error) {
			t.Fatal("empty note must not upsert")
			return "", nil
		}
		got, err := svc.Set(context.Background(), "alice", "bob", "   ")
		if err != nil {
			t.Fatalf("Set(empty): %v", err)
		}
		if !deleted || got.Note != "" || got.UpdatedAt != nil {
			t.Errorf("Set(empty) = %+v (deleted %v), want cleared", got, deleted)
		}
	})

	t.Run("unknown target is not found", func(t *testing.T) {
		_, _, svc := newUserNoteFixture()
		if _, err := svc.Set(context.Background(), "alice", "ghost", "hi"); !errors.Is(err, pkg.ErrNotFound) {
			t.Errorf("err = %v, want ErrNotFound", err)
		}
	})

	t.Run("invalid note is a bad request", func(t *testing.T) {
		_, _, svc := newUserNoteFixture()
		for _, bad := range []string{"a\u200bb", strings.Repeat("x", models.NoteMaxRunes+1)} {
			if _, err := svc.Set(context.Background(), "alice", "bob", bad); !errors.Is(err, pkg.ErrBadRequest) {
				t.Errorf("Set(%q) err = %v, want ErrBadRequest", bad[:4], err)
			}
		}
	})
}
