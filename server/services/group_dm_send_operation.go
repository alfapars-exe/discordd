package services

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func (s *groupDMService) PrepareSend(ctx context.Context, group, user string, req *models.CreateGroupDMMessageRequest, hash string, count int) (*models.GroupSendOperation, error) {
	if _, err := s.requireMember(ctx, group, user); err != nil {
		return nil, err
	}
	if err := req.Validate(); err != nil {
		return nil, badGroupRequest(err)
	}
	if len(*req.Ciphertext) > 2_000_000 || (req.E2EEMetadata != nil && (len(*req.E2EEMetadata) > 1_000_000 || !json.Valid([]byte(*req.E2EEMetadata)))) {
		return nil, pkg.ErrBadRequest
	}
	op, _, err := s.groups.PrepareSend(ctx, group, user, req.ClientRequestID, hash, count)
	if err == nil {
		req.RequestHash = hash
	}
	return op, err
}

func (s *groupDMService) GetSendOutcome(ctx context.Context, group, user, key string) (*models.GroupSendOutcome, error) {
	if !models.ValidGroupSendRequestID(key) {
		return nil, pkg.ErrBadRequest
	}
	if _, err := s.requireMember(ctx, group, user); err != nil {
		return nil, err
	}
	op, err := s.groups.GetSendOperation(ctx, group, user, key)
	if err != nil {
		return nil, err
	}
	out := &models.GroupSendOutcome{Operation: op}
	if op.Phase == "prepared" || op.Phase == "deleted" || op.Phase == "cancelled" {
		return out, nil
	}
	m, err := s.groups.GetMessage(ctx, group, op.MessageID)
	if err != nil {
		return nil, err
	}
	if m.UserID != user {
		return nil, pkg.ErrNotFound
	}
	author, err := s.users.GetByID(ctx, user)
	if err != nil {
		return nil, err
	}
	m.User = models.ToPublicUser(author)
	attachments, err := s.groups.GetAttachments(ctx, []string{m.ID})
	if err != nil {
		return nil, err
	}
	m.Attachments = attachments[m.ID]
	if m.Attachments == nil {
		m.Attachments = []models.GroupDMAttachment{}
	}
	reactions, err := s.groups.GetReactions(ctx, []string{m.ID})
	if err != nil {
		return nil, err
	}
	m.Reactions = reactions[m.ID]
	if m.Reactions == nil {
		m.Reactions = []models.ReactionGroup{}
	}
	// Do not return even a just-loaded snapshot after membership was revoked.
	if _, err = s.requireMember(ctx, group, user); err != nil {
		return nil, err
	}
	out.Message = m
	return out, nil
}

func (s *groupDMService) CancelSend(ctx context.Context, group, user, key string) (*models.GroupSendOutcome, error) {
	if _, err := s.requireMember(ctx, group, user); err != nil {
		return nil, err
	}
	if _, err := s.groups.CancelSend(ctx, group, user, key); err != nil {
		return nil, err
	}
	// If the commit won the race, return its actual state; cancellation is not
	// claimed and no message/attachment is deleted or modified.
	return s.GetSendOutcome(ctx, group, user, key)
}

func (s *groupDMService) CompleteSend(ctx context.Context, group, user, key string, failed []int) (*models.GroupSendOperation, error) {
	if _, err := s.requireMember(ctx, group, user); err != nil {
		return nil, err
	}
	return s.groups.CompleteSend(ctx, group, user, key, failed)
}

// A client must explicitly POST reconciliation. GET remains read-only. After
// the grace period, missing upload positions become failures, never new sends.
// The repository lock fences the old worker's remaining attachment inserts.
func (s *groupDMService) ReconcileSend(ctx context.Context, group, user, key string) (*models.GroupSendOutcome, error) {
	for attempt := 0; attempt < 3; attempt++ {
		out, err := s.GetSendOutcome(ctx, group, user, key)
		if err != nil {
			return nil, err
		}
		op := out.Operation
		if op.Phase != "committed" || time.Since(op.UpdatedAt) < 2*time.Minute {
			return out, nil
		}
		present := make(map[int]bool)
		for _, a := range out.Message.Attachments {
			if a.FileKeyIndex == nil || *a.FileKeyIndex < 0 || *a.FileKeyIndex >= op.FileCount {
				return nil, pkg.ErrConflict
			}
			present[*a.FileKeyIndex] = true
		}
		failed := []int{}
		for i := 0; i < op.FileCount; i++ {
			if !present[i] {
				failed = append(failed, i)
			}
		}
		if _, err = s.CompleteSend(ctx, group, user, key, failed); errors.Is(err, pkg.ErrConflict) {
			continue
		} else if err != nil {
			return nil, err
		}
		return s.GetSendOutcome(ctx, group, user, key)
	}
	return nil, pkg.ErrConflict
}
