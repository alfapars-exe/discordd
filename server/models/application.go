package models

import "time"

const (
	ApplicationScopeReadMessage  = "read_message"
	ApplicationScopeSendResponse = "send_response"
)

type ApplicationAction struct {
	ID       string `json:"id"`
	BotID    string `json:"application_id"`
	Name     string `json:"name"`
	Label    string `json:"label"`
	Context  string `json:"context"`
	Position int    `json:"position"`
}

type ApplicationManifest struct {
	BotID       string              `json:"application_id"`
	Description string              `json:"description"`
	TestMode    bool                `json:"test_mode"`
	UpdatedAt   time.Time           `json:"updated_at"`
	Actions     []ApplicationAction `json:"actions"`
}

type ApplicationInstallation struct {
	BotID       string     `json:"application_id"`
	BotName     string     `json:"application_name"`
	ServerID    string     `json:"server_id"`
	Scopes      []string   `json:"scopes"`
	InstalledBy string     `json:"installed_by"`
	InstalledAt time.Time  `json:"installed_at"`
	RevokedAt   *time.Time `json:"revoked_at,omitempty"`
}

type ApplicationInvocation struct {
	ID          string     `json:"id"`
	ActionID    string     `json:"action_id"`
	BotID       string     `json:"application_id"`
	ActorUserID string     `json:"actor_user_id"`
	ServerID    *string    `json:"server_id,omitempty"`
	ChannelID   *string    `json:"channel_id,omitempty"`
	MessageID   *string    `json:"message_id,omitempty"`
	IsTest      bool       `json:"is_test"`
	Status      string     `json:"status"`
	ResultText  *string    `json:"result_text,omitempty"`
	ErrorCode   *string    `json:"error_code,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	ExpiresAt   time.Time  `json:"expires_at"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
}

type ApplicationInvocationContext struct {
	Invocation     ApplicationInvocation `json:"invocation"`
	ActionName     string                `json:"action_name"`
	MessageContent *string               `json:"message_content,omitempty"`
}
