package testutil

import (
	"context"

	"github.com/argeinfina/hichat/models"
)

// ─── MessageRepository mock ───

type MockMessageRepo struct {
	CreateFn         func(ctx context.Context, message *models.Message) error
	GetByIDFn        func(ctx context.Context, id string) (*models.Message, error)
	GetByChannelIDFn func(ctx context.Context, channelID string, beforeID string, limit int) ([]models.Message, error)
	UpdateFn         func(ctx context.Context, message *models.Message) error
	DeleteFn         func(ctx context.Context, id string) error
}

func (m *MockMessageRepo) Create(ctx context.Context, message *models.Message) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, message)
	}
	return nil
}
func (m *MockMessageRepo) GetByID(ctx context.Context, id string) (*models.Message, error) {
	if m.GetByIDFn != nil {
		return m.GetByIDFn(ctx, id)
	}
	return nil, nil
}
func (m *MockMessageRepo) GetByChannelID(ctx context.Context, channelID string, beforeID string, limit int) ([]models.Message, error) {
	if m.GetByChannelIDFn != nil {
		return m.GetByChannelIDFn(ctx, channelID, beforeID, limit)
	}
	return nil, nil
}
func (m *MockMessageRepo) Update(ctx context.Context, message *models.Message) error {
	if m.UpdateFn != nil {
		return m.UpdateFn(ctx, message)
	}
	return nil
}
func (m *MockMessageRepo) Delete(ctx context.Context, id string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, id)
	}
	return nil
}

// ─── AttachmentRepository mock ───

type MockAttachmentRepo struct {
	CreateFn          func(ctx context.Context, attachment *models.Attachment) error
	GetByMessageIDFn  func(ctx context.Context, messageID string) ([]models.Attachment, error)
	GetByMessageIDsFn func(ctx context.Context, messageIDs []string) ([]models.Attachment, error)
	DeleteFn          func(ctx context.Context, id string) error
}

func (m *MockAttachmentRepo) Create(ctx context.Context, attachment *models.Attachment) error {
	if m.CreateFn != nil {
		return m.CreateFn(ctx, attachment)
	}
	return nil
}
func (m *MockAttachmentRepo) GetByMessageID(ctx context.Context, messageID string) ([]models.Attachment, error) {
	if m.GetByMessageIDFn != nil {
		return m.GetByMessageIDFn(ctx, messageID)
	}
	return nil, nil
}
func (m *MockAttachmentRepo) GetByMessageIDs(ctx context.Context, messageIDs []string) ([]models.Attachment, error) {
	if m.GetByMessageIDsFn != nil {
		return m.GetByMessageIDsFn(ctx, messageIDs)
	}
	return nil, nil
}
func (m *MockAttachmentRepo) Delete(ctx context.Context, id string) error {
	if m.DeleteFn != nil {
		return m.DeleteFn(ctx, id)
	}
	return nil
}

// GetByFileURL — stub; no test exercises the upload-download lookup.
func (m *MockAttachmentRepo) GetByFileURL(_ context.Context, _ string) (*models.Attachment, error) {
	return nil, nil
}

// ─── MentionRepository mock ───

type MockMentionRepo struct {
	SaveMentionsFn        func(ctx context.Context, messageID string, userIDs []string) error
	DeleteByMessageIDFn   func(ctx context.Context, messageID string) error
	GetMentionedUserIDsFn func(ctx context.Context, messageID string) ([]string, error)
	GetByMessageIDsFn     func(ctx context.Context, messageIDs []string) (map[string][]string, error)
}

func (m *MockMentionRepo) SaveMentions(ctx context.Context, messageID string, userIDs []string) error {
	if m.SaveMentionsFn != nil {
		return m.SaveMentionsFn(ctx, messageID, userIDs)
	}
	return nil
}
func (m *MockMentionRepo) DeleteByMessageID(ctx context.Context, messageID string) error {
	if m.DeleteByMessageIDFn != nil {
		return m.DeleteByMessageIDFn(ctx, messageID)
	}
	return nil
}
func (m *MockMentionRepo) GetMentionedUserIDs(ctx context.Context, messageID string) ([]string, error) {
	if m.GetMentionedUserIDsFn != nil {
		return m.GetMentionedUserIDsFn(ctx, messageID)
	}
	return nil, nil
}
func (m *MockMentionRepo) GetByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]string, error) {
	if m.GetByMessageIDsFn != nil {
		return m.GetByMessageIDsFn(ctx, messageIDs)
	}
	return nil, nil
}

// ─── RoleMentionRepository mock ───

type MockRoleMentionRepo struct {
	SaveRoleMentionsFn  func(ctx context.Context, messageID string, roleIDs []string) error
	DeleteByMessageIDFn func(ctx context.Context, messageID string) error
	GetByMessageIDsFn   func(ctx context.Context, messageIDs []string) (map[string][]string, error)
}

func (m *MockRoleMentionRepo) SaveRoleMentions(ctx context.Context, messageID string, roleIDs []string) error {
	if m.SaveRoleMentionsFn != nil {
		return m.SaveRoleMentionsFn(ctx, messageID, roleIDs)
	}
	return nil
}
func (m *MockRoleMentionRepo) DeleteByMessageID(ctx context.Context, messageID string) error {
	if m.DeleteByMessageIDFn != nil {
		return m.DeleteByMessageIDFn(ctx, messageID)
	}
	return nil
}
func (m *MockRoleMentionRepo) GetByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]string, error) {
	if m.GetByMessageIDsFn != nil {
		return m.GetByMessageIDsFn(ctx, messageIDs)
	}
	return nil, nil
}

// ─── ReactionRepository mock ───

type MockReactionRepo struct {
	ToggleFn          func(ctx context.Context, messageID, userID, emoji string) (bool, error)
	GetByMessageIDFn  func(ctx context.Context, messageID string) ([]models.ReactionGroup, error)
	GetByMessageIDsFn func(ctx context.Context, messageIDs []string) (map[string][]models.ReactionGroup, error)
}

func (m *MockReactionRepo) Toggle(ctx context.Context, messageID, userID, emoji string) (bool, error) {
	if m.ToggleFn != nil {
		return m.ToggleFn(ctx, messageID, userID, emoji)
	}
	return false, nil
}
func (m *MockReactionRepo) GetByMessageID(ctx context.Context, messageID string) ([]models.ReactionGroup, error) {
	if m.GetByMessageIDFn != nil {
		return m.GetByMessageIDFn(ctx, messageID)
	}
	return nil, nil
}
func (m *MockReactionRepo) GetByMessageIDs(ctx context.Context, messageIDs []string) (map[string][]models.ReactionGroup, error) {
	if m.GetByMessageIDsFn != nil {
		return m.GetByMessageIDsFn(ctx, messageIDs)
	}
	return nil, nil
}
