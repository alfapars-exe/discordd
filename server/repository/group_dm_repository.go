package repository

import (
	"context"
	"github.com/argeinfina/hichat/models"
)

type GroupDMRepository interface {
	SetMessagePinned(ctx context.Context, groupID, messageID, userID string, pinned bool) error
	ListPinnedMessages(ctx context.Context, groupID, userID string) ([]models.GroupDMMessage, error)
	PrepareSend(ctx context.Context, groupID, userID, requestID, requestHash string, fileCount int) (*models.GroupSendOperation, bool, error)
	CancelSend(ctx context.Context, groupID, userID, requestID string) (*models.GroupSendOperation, error)
	GetSendOperation(ctx context.Context, groupID, userID, requestID string) (*models.GroupSendOperation, error)
	CompleteSend(ctx context.Context, groupID, userID, requestID string, failedIndices []int) (*models.GroupSendOperation, error)
	Create(ctx context.Context, group *models.GroupDM, memberIDs []string) error
	GetByID(ctx context.Context, id string) (*models.GroupDM, error)
	ListForUser(ctx context.Context, userID string) ([]models.GroupDM, error)
	ListMemberIDs(ctx context.Context, groupID string) ([]string, error)
	IsMember(ctx context.Context, groupID, userID string) (bool, error)
	AddMember(ctx context.Context, groupID, userID string) (int64, error)
	RemoveMember(ctx context.Context, groupID, userID string) (int64, error)
	UpdateProfile(ctx context.Context, groupID, name string, iconURL *string) error
	TransferOwner(ctx context.Context, groupID, userID string) error
	Delete(ctx context.Context, groupID string) error
	CreateMessage(ctx context.Context, message *models.GroupDMMessage) error
	GetMessage(ctx context.Context, groupID, messageID string) (*models.GroupDMMessage, error)
	GetMessageByID(ctx context.Context, messageID string) (*models.GroupDMMessage, error)
	ListMessages(ctx context.Context, groupID, beforeID string, limit int) ([]models.GroupDMMessage, error)
	GetMessagesAround(ctx context.Context, groupID, anchorID string, limit int) ([]models.GroupDMMessage, bool, bool, error)
	UpdateMessage(ctx context.Context, groupID, messageID, userID string, req *models.UpdateGroupDMMessageRequest) error
	DeleteMessage(ctx context.Context, groupID, messageID, userID string) error
	ToggleReaction(ctx context.Context, messageID, userID, emoji string) (bool, error)
	GetReactions(ctx context.Context, messageIDs []string) (map[string][]models.ReactionGroup, error)
	MarkRead(ctx context.Context, groupID, userID string, messageID *string) error
	MarkUnreadFrom(ctx context.Context, groupID, userID, messageID string) (*models.GroupDMReadState, error)
	GetReadState(ctx context.Context, groupID, userID string) (*models.GroupDMReadState, error)
	UnreadCount(ctx context.Context, groupID, userID string) (int, error)
	CreateAttachment(ctx context.Context, attachment *models.GroupDMAttachment) error
	GetAttachments(ctx context.Context, messageIDs []string) (map[string][]models.GroupDMAttachment, error)
	GetAttachmentByFileURL(ctx context.Context, fileURL string) (*models.GroupDMAttachment, error)
	GetAttachmentFileURLsByGroup(ctx context.Context, groupID string) ([]string, error)
}
