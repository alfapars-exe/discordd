package models

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/argeinfina/hichat/pkg"
)

type GroupDM struct {
	IsMuted               bool         `json:"is_muted"`
	SettingsRevision      int64        `json:"settings_revision"`
	ID                    string       `json:"id"`
	OwnerID               string       `json:"owner_id"`
	Name                  string       `json:"name"`
	IconURL               *string      `json:"icon_url"`
	KeyEpoch              int64        `json:"key_epoch"`
	CallRoomKey           string       `json:"call_room_key"`
	CreatedAt             time.Time    `json:"created_at"`
	UpdatedAt             time.Time    `json:"updated_at"`
	Members               []PublicUser `json:"members"`
	UnreadCount           int          `json:"unread_count"`
	ReadRevision          int64        `json:"read_revision"`
	OldestUnreadMessageID *string      `json:"oldest_unread_message_id,omitempty"`
}

type GroupDMReadState struct {
	IsMuted               bool    `json:"is_muted"`
	SettingsRevision      int64   `json:"settings_revision"`
	GroupID               string  `json:"group_id"`
	LastReadMessageID     *string `json:"last_read_message_id"`
	UnreadCount           int     `json:"unread_count"`
	Revision              int64   `json:"revision"`
	OldestUnreadMessageID *string `json:"oldest_unread_message_id,omitempty"`
}

type CreateGroupDMRequest struct {
	Name    string   `json:"name"`
	UserIDs []string `json:"user_ids"`
}

func (r *CreateGroupDMRequest) Validate() error {
	r.Name = strings.TrimSpace(r.Name)
	if n := utf8.RuneCountInString(r.Name); n < 1 || n > 100 {
		return fmt.Errorf("group name must be between 1 and 100 characters")
	}
	if len(r.UserIDs) < 1 || len(r.UserIDs) > 9 {
		return fmt.Errorf("group must contain between 2 and 10 members")
	}
	return nil
}

type UpdateGroupDMRequest struct {
	Name    string  `json:"name"`
	IconURL *string `json:"icon_url"`
}

func (r *UpdateGroupDMRequest) Validate() error {
	r.Name = strings.TrimSpace(r.Name)
	if n := utf8.RuneCountInString(r.Name); n < 1 || n > 100 {
		return fmt.Errorf("group name must be between 1 and 100 characters")
	}
	if pkg.ContainsSteeringChars(r.Name) {
		return fmt.Errorf("group name contains disallowed control or formatting characters")
	}
	return nil
}

type GroupDMMessage struct {
	// Internal binding to a durable send operation; never accepted from message JSON.
	SendRequestID     string              `json:"-"`
	ID                string              `json:"id"`
	GroupID           string              `json:"group_id"`
	UserID            string              `json:"user_id"`
	Content           *string             `json:"content,omitempty"`
	EncryptionVersion int                 `json:"encryption_version"`
	Ciphertext        *string             `json:"ciphertext,omitempty"`
	SenderDeviceID    *string             `json:"sender_device_id,omitempty"`
	E2EEMetadata      *string             `json:"e2ee_metadata,omitempty"`
	KeyEpoch          int64               `json:"key_epoch"`
	ReplyToID         *string             `json:"reply_to_id,omitempty"`
	EditedAt          *time.Time          `json:"edited_at,omitempty"`
	CreatedAt         time.Time           `json:"created_at"`
	User              *PublicUser         `json:"user,omitempty"`
	Reactions         []ReactionGroup     `json:"reactions"`
	Attachments       []GroupDMAttachment `json:"attachments"`
}

// GroupDMMessagePage is an ASC window centered on an authorized message ID.
type GroupDMMessagePage struct {
	Messages     []GroupDMMessage `json:"messages"`
	HasMore      bool             `json:"has_more"`
	HasMoreAfter bool             `json:"has_more_after"`
}

type GroupDMAttachment struct {
	ID             string    `json:"id"`
	GroupMessageID string    `json:"group_message_id"`
	Filename       string    `json:"filename"`
	FileURL        string    `json:"file_url"`
	FileSize       *int64    `json:"file_size"`
	MimeType       *string   `json:"mime_type"`
	FileKeyIndex   *int      `json:"file_key_index,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
}

type UpdateGroupDMMessageRequest struct {
	Ciphertext     *string `json:"ciphertext"`
	SenderDeviceID *string `json:"sender_device_id"`
	E2EEMetadata   *string `json:"e2ee_metadata"`
	KeyEpoch       int64   `json:"key_epoch"`
}

func (r *UpdateGroupDMMessageRequest) Validate() error {
	if r.Ciphertext == nil || strings.TrimSpace(*r.Ciphertext) == "" || r.SenderDeviceID == nil || strings.TrimSpace(*r.SenderDeviceID) == "" {
		return fmt.Errorf("encrypted group message payload is required")
	}
	if r.KeyEpoch < 1 {
		return fmt.Errorf("key_epoch is required")
	}
	return nil
}

type CreateGroupDMMessageRequest struct {
	ClientRequestID string  `json:"client_request_id,omitempty"`
	RequestHash     string  `json:"-"`
	Content         string  `json:"content"`
	Ciphertext      *string `json:"ciphertext"`
	SenderDeviceID  *string `json:"sender_device_id"`
	E2EEMetadata    *string `json:"e2ee_metadata"`
	KeyEpoch        int64   `json:"key_epoch"`
	ReplyToID       *string `json:"reply_to_id"`
}

func (r *CreateGroupDMMessageRequest) Validate() error {
	if r.ClientRequestID != "" && !ValidGroupSendRequestID(r.ClientRequestID) {
		return fmt.Errorf("invalid client_request_id")
	}
	if r.Ciphertext == nil || strings.TrimSpace(*r.Ciphertext) == "" || r.SenderDeviceID == nil || strings.TrimSpace(*r.SenderDeviceID) == "" {
		return fmt.Errorf("encrypted group message payload is required")
	}
	if r.KeyEpoch < 1 {
		return fmt.Errorf("key_epoch is required")
	}
	return nil
}
