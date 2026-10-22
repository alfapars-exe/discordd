package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
)

// UserNoteService serves the caller's private note about another user
// (user_notes, migration 084). Notes are owner-scoped on every read and
// write, so the target never learns one exists.
type UserNoteService interface {
	// Get returns {note: "", updated_at: nil} when no note is stored.
	Get(ctx context.Context, ownerUserID, targetUserID string) (*models.UserNote, error)
	// Set stores the (normalised) note; an empty note deletes the row and
	// answers {note: "", updated_at: nil}. pkg.ErrNotFound when the target
	// user does not exist, pkg.ErrBadRequest on an invalid note.
	Set(ctx context.Context, ownerUserID, targetUserID, note string) (*models.UserNote, error)
}

type userNoteService struct {
	noteRepo repository.UserNoteRepository
	userRepo repository.UserRepository
}

func NewUserNoteService(noteRepo repository.UserNoteRepository, userRepo repository.UserRepository) UserNoteService {
	return &userNoteService{noteRepo: noteRepo, userRepo: userRepo}
}

func (s *userNoteService) Get(ctx context.Context, ownerUserID, targetUserID string) (*models.UserNote, error) {
	note, updatedAt, err := s.noteRepo.Get(ctx, ownerUserID, targetUserID)
	if err != nil {
		return nil, fmt.Errorf("failed to get user note: %w", err)
	}
	return &models.UserNote{Note: note, UpdatedAt: updatedAt}, nil
}

func (s *userNoteService) Set(ctx context.Context, ownerUserID, targetUserID, note string) (*models.UserNote, error) {
	normalized, err := models.NormalizeNote(note)
	if err != nil {
		return nil, err
	}

	// The target must exist: user_notes.target_user_id references users and
	// a note about a phantom id would be unreachable from any profile.
	if _, err := s.userRepo.GetByID(ctx, targetUserID); err != nil {
		return nil, fmt.Errorf("%w: user not found", pkg.ErrNotFound)
	}

	if normalized == "" {
		if err := s.noteRepo.Delete(ctx, ownerUserID, targetUserID); err != nil {
			return nil, fmt.Errorf("failed to clear user note: %w", err)
		}
		return &models.UserNote{Note: ""}, nil
	}

	updatedAt, err := s.noteRepo.Upsert(ctx, ownerUserID, targetUserID, normalized)
	if err != nil {
		return nil, fmt.Errorf("failed to store user note: %w", err)
	}
	return &models.UserNote{Note: normalized, UpdatedAt: &updatedAt}, nil
}
