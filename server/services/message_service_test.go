package services

import (
	"context"
	"errors"
	"sort"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// noopReadStateRepo — minimal ReadStateRepository stub for tests.
// The production NewMessageService grew readStateRepo + timeoutRepo
// dependencies after these tests were written; rather than thread two
// new args through 9 call sites, we satisfy the interfaces with
// always-succeed stubs (the test helper hides them entirely).
type noopReadStateRepo struct{}

func (noopReadStateRepo) Upsert(_ context.Context, _, _, _ string) error { return nil }
func (noopReadStateRepo) GetUnreadCounts(_ context.Context, _, _ string) ([]models.UnreadInfo, error) {
	return nil, nil
}
func (noopReadStateRepo) MarkAllRead(_ context.Context, _, _ string) error           { return nil }
func (noopReadStateRepo) IncrementUnreadCounts(_ context.Context, _, _ string) error { return nil }
func (noopReadStateRepo) DecrementUnreadForDeleted(_ context.Context, _, _ string, _ time.Time) error {
	return nil
}

// noopTimeoutRepo — minimal MemberTimeoutRepository stub. Returns
// "no active timeout" for every Get; everything else is a no-op.
type noopTimeoutRepo struct{}

func (noopTimeoutRepo) Upsert(_ context.Context, _ *models.MemberTimeout) error { return nil }
func (noopTimeoutRepo) Get(_ context.Context, _, _ string) (*models.MemberTimeout, error) {
	return nil, nil
}
func (noopTimeoutRepo) Delete(_ context.Context, _, _ string) error           { return nil }
func (noopTimeoutRepo) IsActive(_ context.Context, _, _ string) (bool, error) { return false, nil }
func (noopTimeoutRepo) ListActive(_ context.Context, _ string) ([]models.MemberTimeout, error) {
	return nil, nil
}

var (
	_ repository.ReadStateRepository     = noopReadStateRepo{}
	_ repository.MemberTimeoutRepository = noopTimeoutRepo{}
)

// passthroughTxRunner satisfies repository.MessageTxRunner without a real
// transaction: fn runs directly against the test's mock repos, so per-case
// Fn overrides apply inside the "transaction" too. True rollback semantics
// are covered by repository/message_tx_test.go against a real database.
type passthroughTxRunner struct {
	repos repository.MessageTxRepos
}

func (p passthroughTxRunner) InTx(_ context.Context, fn func(*repository.MessageTxRepos) error) error {
	r := p.repos
	return fn(&r)
}

func newTestMessageService(
	msgRepo *testutil.MockMessageRepo,
	attachRepo *testutil.MockAttachmentRepo,
	chanRepo *testutil.MockChannelRepo,
	userRepo *testutil.MockUserRepo,
	mentionRepo *testutil.MockMentionRepo,
	roleMentionRepo *testutil.MockRoleMentionRepo,
	roleRepo *testutil.MockRoleRepo,
	reactionRepo *testutil.MockReactionRepo,
	hub *testutil.MockBroadcastAndOnline,
	permResolver ChannelPermResolver,
) MessageService {
	runner := passthroughTxRunner{repos: repository.MessageTxRepos{
		Message:     msgRepo,
		Mention:     mentionRepo,
		RoleMention: roleMentionRepo,
		ReadState:   noopReadStateRepo{},
	}}
	return NewMessageService(
		msgRepo, attachRepo, chanRepo, userRepo,
		mentionRepo, roleMentionRepo, roleRepo, reactionRepo,
		noopReadStateRepo{}, noopTimeoutRepo{},
		runner, hub, permResolver,
	)
}

func TestMessageCreate(t *testing.T) {
	tests := []struct {
		name        string
		content     string
		perms       models.Permission
		wantErr     bool
		errSentinel error
	}{
		{
			name:    "should create message successfully",
			content: "hello world",
			perms:   models.PermSendMessages | models.PermReadMessages | models.PermViewChannel,
		},
		{
			name:        "should fail when content is empty",
			content:     "",
			perms:       models.PermSendMessages,
			wantErr:     true,
			errSentinel: pkg.ErrBadRequest,
		},
		{
			name:        "should fail when missing send permission",
			content:     "hello",
			perms:       models.PermReadMessages | models.PermViewChannel, // no SendMessages
			wantErr:     true,
			errSentinel: pkg.ErrForbidden,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := newTestMessageService(
				&testutil.MockMessageRepo{},
				&testutil.MockAttachmentRepo{},
				&testutil.MockChannelRepo{
					GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
						return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
					},
				},
				&testutil.MockUserRepo{
					GetByIDFn: func(_ context.Context, _ string) (*models.User, error) {
						return &models.User{ID: "u1", Username: "alice"}, nil
					},
					GetByUsernameFn: func(_ context.Context, _ string) (*models.User, error) {
						return nil, pkg.ErrNotFound
					},
				},
				&testutil.MockMentionRepo{},
				&testutil.MockRoleMentionRepo{},
				&testutil.MockRoleRepo{},
				&testutil.MockReactionRepo{},
				&testutil.MockBroadcastAndOnline{},
				&testutil.MockChannelPermResolver{
					ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
						return tt.perms, nil
					},
				},
			)

			req := &models.CreateMessageRequest{Content: tt.content}
			msg, err := svc.Create(context.Background(), "srv1", "ch1", "u1", req)

			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if tt.errSentinel != nil && !errors.Is(err, tt.errSentinel) {
					t.Errorf("expected %v, got %v", tt.errSentinel, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if msg.Content == nil || *msg.Content != tt.content {
				t.Errorf("content = %v, want %q", msg.Content, tt.content)
			}
			if msg.Author == nil || msg.Author.ID != "u1" {
				t.Error("author should be populated")
			}
		})
	}
}

func TestMessageCreate_MaxLength(t *testing.T) {
	longContent := make([]byte, models.MaxMessageLength+1)
	for i := range longContent {
		longContent[i] = 'a'
	}

	svc := newTestMessageService(
		&testutil.MockMessageRepo{},
		&testutil.MockAttachmentRepo{},
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
				return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
			},
		},
		&testutil.MockUserRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.User, error) {
				return &models.User{ID: "u1"}, nil
			},
			GetByUsernameFn: func(_ context.Context, _ string) (*models.User, error) {
				return nil, pkg.ErrNotFound
			},
		},
		&testutil.MockMentionRepo{},
		&testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{},
		&testutil.MockReactionRepo{},
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermSendMessages | models.PermViewChannel, nil
			},
		},
	)

	req := &models.CreateMessageRequest{Content: string(longContent)}
	_, err := svc.Create(context.Background(), "srv1", "ch1", "u1", req)
	if err == nil {
		t.Fatal("expected error for content exceeding max length")
	}
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Errorf("expected ErrBadRequest, got %v", err)
	}
}

func TestMessageGetByChannelID(t *testing.T) {
	tests := []struct {
		name      string
		perms     models.Permission
		dbMsgs    []models.Message
		limit     int
		wantCount int
		wantMore  bool
		wantErr   bool
	}{
		{
			name:  "should return messages with pagination",
			perms: models.PermReadMessages | models.PermViewChannel,
			dbMsgs: []models.Message{
				{ID: "m3"}, {ID: "m2"}, {ID: "m1"}, // DESC order from DB
			},
			limit:     2,
			wantCount: 2,
			wantMore:  true,
		},
		{
			name:  "should return all when fewer than limit",
			perms: models.PermReadMessages | models.PermViewChannel,
			dbMsgs: []models.Message{
				{ID: "m1"},
			},
			limit:     50,
			wantCount: 1,
			wantMore:  false,
		},
		{
			name:    "should fail without read permission",
			perms:   models.PermSendMessages | models.PermViewChannel, // no ReadMessages
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := newTestMessageService(
				&testutil.MockMessageRepo{
					GetByChannelIDFn: func(_ context.Context, _ string, _ string, limit int) ([]models.Message, error) {
						if limit <= len(tt.dbMsgs) {
							return tt.dbMsgs[:limit], nil
						}
						return tt.dbMsgs, nil
					},
				},
				&testutil.MockAttachmentRepo{},
				&testutil.MockChannelRepo{
					GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
						return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
					},
				},
				&testutil.MockUserRepo{},
				&testutil.MockMentionRepo{},
				&testutil.MockRoleMentionRepo{},
				&testutil.MockRoleRepo{},
				&testutil.MockReactionRepo{},
				&testutil.MockBroadcastAndOnline{},
				&testutil.MockChannelPermResolver{
					ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
						return tt.perms, nil
					},
				},
			)

			page, err := svc.GetByChannelID(context.Background(), "srv1", "ch1", "u1", "", tt.limit)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(page.Messages) != tt.wantCount {
				t.Errorf("message count = %d, want %d", len(page.Messages), tt.wantCount)
			}
			if page.HasMore != tt.wantMore {
				t.Errorf("hasMore = %v, want %v", page.HasMore, tt.wantMore)
			}
		})
	}
}

func TestMessageDelete(t *testing.T) {
	tests := []struct {
		name      string
		msgUserID string
		delUserID string
		delPerms  models.Permission
		wantErr   bool
	}{
		{
			name:      "owner can delete own message",
			msgUserID: "u1",
			delUserID: "u1",
			delPerms:  0,
		},
		{
			name:      "admin can delete others message",
			msgUserID: "u1",
			delUserID: "u2",
			delPerms:  models.PermManageMessages,
		},
		{
			name:      "non-owner without permission cannot delete",
			msgUserID: "u1",
			delUserID: "u2",
			delPerms:  0,
			wantErr:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			broadcastCalled := false
			svc := newTestMessageService(
				&testutil.MockMessageRepo{
					GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
						return &models.Message{ID: "m1", UserID: tt.msgUserID, ChannelID: "ch1"}, nil
					},
				},
				&testutil.MockAttachmentRepo{},
				&testutil.MockChannelRepo{
					GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
						return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
					},
				},
				&testutil.MockUserRepo{},
				&testutil.MockMentionRepo{},
				&testutil.MockRoleMentionRepo{},
				&testutil.MockRoleRepo{},
				&testutil.MockReactionRepo{},
				&testutil.MockBroadcastAndOnline{
					MockBroadcaster: testutil.MockBroadcaster{
						BroadcastToUsersFn: func(_ []string, _ ws.Event) { broadcastCalled = true },
					},
				},
				&testutil.MockChannelPermResolver{},
			)

			err := svc.Delete(context.Background(), "srv1", "m1", tt.delUserID, tt.delPerms)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				if !errors.Is(err, pkg.ErrForbidden) {
					t.Errorf("expected ErrForbidden, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !broadcastCalled {
				t.Error("delete should broadcast event")
			}
		})
	}
}

func TestMessageUpdate_OnlyOwnerCanEdit(t *testing.T) {
	svc := newTestMessageService(
		&testutil.MockMessageRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
				return &models.Message{ID: "m1", UserID: "u1", ChannelID: "ch1"}, nil
			},
		},
		&testutil.MockAttachmentRepo{},
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
				return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
			},
		},
		&testutil.MockUserRepo{},
		&testutil.MockMentionRepo{},
		&testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{},
		&testutil.MockReactionRepo{},
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{},
	)

	req := &models.UpdateMessageRequest{Content: "updated"}
	_, err := svc.Update(context.Background(), "srv1", "m1", "u2", req)
	if err == nil {
		t.Fatal("expected error when non-owner edits")
	}
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("expected ErrForbidden, got %v", err)
	}
}

func TestMessageCreate_E2EE(t *testing.T) {
	cipher := "encrypted-blob"
	deviceID := "dev1"
	svc := newTestMessageService(
		&testutil.MockMessageRepo{},
		&testutil.MockAttachmentRepo{},
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
				return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
			},
		},
		&testutil.MockUserRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.User, error) {
				return &models.User{ID: "u1", Username: "alice"}, nil
			},
			GetByUsernameFn: func(_ context.Context, _ string) (*models.User, error) {
				return nil, pkg.ErrNotFound
			},
		},
		&testutil.MockMentionRepo{},
		&testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{},
		&testutil.MockReactionRepo{},
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermSendMessages | models.PermViewChannel, nil
			},
		},
	)

	req := &models.CreateMessageRequest{
		EncryptionVersion: 1,
		Ciphertext:        &cipher,
		SenderDeviceID:    &deviceID,
	}
	msg, err := svc.Create(context.Background(), "srv1", "ch1", "u1", req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if msg.Content != nil {
		t.Error("E2EE message should have nil Content")
	}
	if msg.Ciphertext == nil || *msg.Ciphertext != cipher {
		t.Error("ciphertext should be set")
	}
	if msg.EncryptionVersion != 1 {
		t.Errorf("encryption_version = %d, want 1", msg.EncryptionVersion)
	}
}

// TestMessageUpdate_E2EE_PersistsNewCiphertext guards the bug where the
// channel-message repository Update used to write only content+edited_at,
// silently dropping the new E2EE ciphertext. The fix routes E2EE messages
// through the ciphertext/sender_device_id/e2ee_metadata UPDATE path; this
// test asserts the service hands the repository the new envelope so the
// repo's E2EE branch has something to persist.
func TestMessageUpdate_E2EE_PersistsNewCiphertext(t *testing.T) {
	oldCipher := "old-blob"
	oldDevice := "dev1"
	storedMessage := &models.Message{
		ID:                "m1",
		UserID:            "u1",
		ChannelID:         "ch1",
		EncryptionVersion: 1,
		Ciphertext:        &oldCipher,
		SenderDeviceID:    &oldDevice,
	}

	var capturedUpdate *models.Message
	svc := newTestMessageService(
		&testutil.MockMessageRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
				cp := *storedMessage
				return &cp, nil
			},
			UpdateFn: func(_ context.Context, m *models.Message) error {
				capturedUpdate = m
				return nil
			},
		},
		&testutil.MockAttachmentRepo{},
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
				return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
			},
		},
		&testutil.MockUserRepo{},
		&testutil.MockMentionRepo{},
		&testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{},
		&testutil.MockReactionRepo{},
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermViewChannel | models.PermReadMessages, nil
			},
		},
	)

	newCipher := "new-blob"
	newDevice := "dev1"
	newMeta := `{"v":1}`
	req := &models.UpdateMessageRequest{
		EncryptionVersion: 1,
		Ciphertext:        &newCipher,
		SenderDeviceID:    &newDevice,
		E2EEMetadata:      &newMeta,
	}
	_, err := svc.Update(context.Background(), "srv1", "m1", "u1", req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capturedUpdate == nil {
		t.Fatal("repo Update was not called")
	}
	if capturedUpdate.Ciphertext == nil || *capturedUpdate.Ciphertext != newCipher {
		t.Errorf("ciphertext not propagated to repo: got %v, want %q", capturedUpdate.Ciphertext, newCipher)
	}
	if capturedUpdate.SenderDeviceID == nil || *capturedUpdate.SenderDeviceID != newDevice {
		t.Errorf("sender_device_id not propagated: got %v, want %q", capturedUpdate.SenderDeviceID, newDevice)
	}
	if capturedUpdate.E2EEMetadata == nil || *capturedUpdate.E2EEMetadata != newMeta {
		t.Errorf("e2ee_metadata not propagated: got %v, want %q", capturedUpdate.E2EEMetadata, newMeta)
	}
	if capturedUpdate.Content != nil {
		t.Errorf("Content should be cleared on E2EE edit, got %v", *capturedUpdate.Content)
	}
}

// TestMessageUpdate_EncryptionVersionMismatch ensures the service rejects
// requests that try to switch a stored message from plaintext to E2EE (or
// vice versa) — without this check the repo would write the wrong column
// shape because its branch reads message.EncryptionVersion (DB-loaded),
// not req.EncryptionVersion. The defensive 400 keeps the inconsistency
// loud instead of producing silently-broken rows.
func TestMessageUpdate_EncryptionVersionMismatch(t *testing.T) {
	storedMessage := &models.Message{
		ID:                "m1",
		UserID:            "u1",
		ChannelID:         "ch1",
		EncryptionVersion: 0,
	}
	svc := newTestMessageService(
		&testutil.MockMessageRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Message, error) {
				cp := *storedMessage
				return &cp, nil
			},
			UpdateFn: func(_ context.Context, _ *models.Message) error {
				t.Fatal("repo Update should not be called on version mismatch")
				return nil
			},
		},
		&testutil.MockAttachmentRepo{},
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
				return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
			},
		},
		&testutil.MockUserRepo{},
		&testutil.MockMentionRepo{},
		&testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{},
		&testutil.MockReactionRepo{},
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermViewChannel | models.PermReadMessages, nil
			},
		},
	)

	cipher := "blob"
	device := "dev1"
	req := &models.UpdateMessageRequest{
		EncryptionVersion: 1,
		Ciphertext:        &cipher,
		SenderDeviceID:    &device,
	}
	_, err := svc.Update(context.Background(), "srv1", "m1", "u1", req)
	if err == nil {
		t.Fatal("expected error on encryption-version mismatch, got nil")
	}
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Errorf("expected ErrBadRequest, got %v", err)
	}
}

// ─── Timeout gate (A1 regression coverage + DM bypass) ───

// TestMessageCreate_TimedOutUserBlocked wires the service directly (not via
// newTestMessageService, which hard-codes noopTimeoutRepo) with a
// MockMemberTimeoutRepo reporting an active timeout, and asserts Create
// rejects the write before ever touching the message repo.
func TestMessageCreate_TimedOutUserBlocked(t *testing.T) {
	msgRepo := &testutil.MockMessageRepo{
		CreateFn: func(_ context.Context, _ *models.Message) error {
			t.Fatal("message repo Create should not be called for a timed-out user")
			return nil
		},
	}
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
		},
	}
	userRepo := &testutil.MockUserRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.User, error) {
			return &models.User{ID: "u1", Username: "alice"}, nil
		},
		GetByUsernameFn: func(_ context.Context, _ string) (*models.User, error) {
			return nil, pkg.ErrNotFound
		},
	}
	timeoutRepo := &testutil.MockMemberTimeoutRepo{
		IsActiveFn: func(_ context.Context, serverID, userID string) (bool, error) {
			if serverID != "srv1" || userID != "u1" {
				t.Errorf("IsActive called with unexpected args: %s %s", serverID, userID)
			}
			return true, nil
		},
	}
	mentionRepo := &testutil.MockMentionRepo{}
	roleMentionRepo := &testutil.MockRoleMentionRepo{}
	runner := passthroughTxRunner{repos: repository.MessageTxRepos{
		Message:     msgRepo,
		Mention:     mentionRepo,
		RoleMention: roleMentionRepo,
		ReadState:   noopReadStateRepo{},
	}}
	svc := NewMessageService(
		msgRepo, &testutil.MockAttachmentRepo{}, channelRepo, userRepo,
		mentionRepo, roleMentionRepo, &testutil.MockRoleRepo{}, &testutil.MockReactionRepo{},
		noopReadStateRepo{}, timeoutRepo,
		runner, &testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermSendMessages | models.PermReadMessages | models.PermViewChannel, nil
			},
		},
	)

	req := &models.CreateMessageRequest{Content: "hello"}
	_, err := svc.Create(context.Background(), "srv1", "ch1", "u1", req)
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Errorf("Create for timed-out user: expected ErrForbidden, got %v", err)
	}
}

// TestMessageCreate_DMChannelSkipsTimeoutCheck pins the channel.ServerID != ""
// guard in messageService.Create: DM channels (ServerID == "") never call
// IsActive — the timeout system is server-scoped and has no concept of
// timing a user out of their own DMs.
func TestMessageCreate_DMChannelSkipsTimeoutCheck(t *testing.T) {
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "ch-dm", ServerID: ""}, nil
		},
	}
	userRepo := &testutil.MockUserRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.User, error) {
			return &models.User{ID: "u1", Username: "alice"}, nil
		},
		GetByUsernameFn: func(_ context.Context, _ string) (*models.User, error) {
			return nil, pkg.ErrNotFound
		},
	}
	timeoutRepo := &testutil.MockMemberTimeoutRepo{
		IsActiveFn: func(_ context.Context, _, _ string) (bool, error) {
			t.Fatal("IsActive must not be called for a DM (server-less) channel")
			return false, nil
		},
	}
	msgRepo := &testutil.MockMessageRepo{}
	mentionRepo := &testutil.MockMentionRepo{}
	roleMentionRepo := &testutil.MockRoleMentionRepo{}
	runner := passthroughTxRunner{repos: repository.MessageTxRepos{
		Message:     msgRepo,
		Mention:     mentionRepo,
		RoleMention: roleMentionRepo,
		ReadState:   noopReadStateRepo{},
	}}
	svc := NewMessageService(
		msgRepo, &testutil.MockAttachmentRepo{}, channelRepo, userRepo,
		mentionRepo, roleMentionRepo, &testutil.MockRoleRepo{}, &testutil.MockReactionRepo{},
		noopReadStateRepo{}, timeoutRepo,
		runner, &testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermSendMessages | models.PermReadMessages | models.PermViewChannel, nil
			},
		},
	)

	req := &models.CreateMessageRequest{Content: "hello"}
	_, err := svc.Create(context.Background(), "", "ch-dm", "u1", req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// ─── Transactional create: mention failure must fail the whole Create ───
//
// Before the tx refactor, a mention-save failure was only logged and the
// message survived without its mention rows. Now the error propagates (and
// repository/message_tx_test.go proves the DB-level rollback).

func TestMessageCreate_MentionFailurePropagates(t *testing.T) {
	sentinel := errors.New("mention insert exploded")
	svc := newTestMessageService(
		&testutil.MockMessageRepo{},
		&testutil.MockAttachmentRepo{},
		&testutil.MockChannelRepo{
			GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
				return &models.Channel{ID: "ch1", ServerID: "srv1"}, nil
			},
		},
		&testutil.MockUserRepo{
			GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
				return &models.User{ID: id, Username: "alice"}, nil
			},
			GetByUsernameFn: func(_ context.Context, _ string) (*models.User, error) {
				return nil, pkg.ErrNotFound
			},
		},
		&testutil.MockMentionRepo{
			SaveMentionsFn: func(_ context.Context, _ string, _ []string) error {
				return sentinel
			},
		},
		&testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{},
		&testutil.MockReactionRepo{},
		&testutil.MockBroadcastAndOnline{},
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, _, _ string) (models.Permission, error) {
				return models.PermSendMessages | models.PermReadMessages | models.PermViewChannel, nil
			},
		},
	)

	req := &models.CreateMessageRequest{Content: "selam <@deadbeef01>"}
	_, err := svc.Create(context.Background(), "srv1", "ch1", "u1", req)
	if !errors.Is(err, sentinel) {
		t.Fatalf("Create error = %v, want the mention sentinel to propagate (atomic write set)", err)
	}
}

// ─── Broadcast fan-out ───

// TestBroadcastCreate_RecipientsMatchBulkResolver wires the *real*
// ChannelPermissionService behind the message service and proves two things
// about the fan-out after the N+1 removal:
//
//   - the recipient set is exactly the users the resolver says may view + read
//     the channel (a permission answer must not change just because it now
//     comes from the batched query), and
//   - the whole broadcast costs a constant number of queries instead of one
//     resolve per online member.
func TestBroadcastCreate_RecipientsMatchBulkResolver(t *testing.T) {
	const (
		channelID = "ch1"
		serverID  = "srv1"
	)

	// viewer-1/viewer-2 may read; muted-1 holds the same base bits but a deny
	// override strips ReadMessages; stranger-1 has no roles at all.
	rolesByUser := map[string][]models.Role{
		"viewer-1":   {{ID: "r-member", Permissions: models.PermViewChannel | models.PermReadMessages}},
		"viewer-2":   {{ID: "r-member", Permissions: models.PermViewChannel | models.PermReadMessages}},
		"muted-1":    {{ID: "r-muted", Permissions: models.PermViewChannel | models.PermReadMessages}},
		"stranger-1": nil,
	}
	overrides := []models.ChannelPermissionOverride{
		{ChannelID: channelID, RoleID: "r-muted", Deny: models.PermReadMessages},
	}
	online := []string{"viewer-1", "viewer-2", "muted-1", "stranger-1"}

	var queries int
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			queries++
			return &models.Channel{ID: channelID, ServerID: serverID}, nil
		},
	}
	roleRepo := &testutil.MockRoleRepo{
		GetByUserIDAndServerFn: func(_ context.Context, userID, _ string) ([]models.Role, error) {
			queries++
			return rolesByUser[userID], nil
		},
		GetRolesForUsersFn: func(_ context.Context, _ string, userIDs []string) (map[string][]models.Role, error) {
			queries++
			out := make(map[string][]models.Role, len(userIDs))
			for _, uid := range userIDs {
				if rs := rolesByUser[uid]; len(rs) > 0 {
					out[uid] = rs
				}
			}
			return out, nil
		},
	}
	permRepo := &testutil.MockChannelPermRepo{
		GetByChannelFn: func(_ context.Context, _ string) ([]models.ChannelPermissionOverride, error) {
			queries++
			return overrides, nil
		},
		GetByChannelAndRolesFn: func(_ context.Context, _ string, roleIDs []string) ([]models.ChannelPermissionOverride, error) {
			queries++
			set := make(map[string]bool, len(roleIDs))
			for _, id := range roleIDs {
				set[id] = true
			}
			var out []models.ChannelPermissionOverride
			for _, o := range overrides {
				if set[o.RoleID] {
					out = append(out, o)
				}
			}
			return out, nil
		},
	}
	resolver := NewChannelPermissionService(permRepo, roleRepo, channelRepo, &testutil.MockBroadcaster{})

	var got []string
	hub := &testutil.MockBroadcastAndOnline{
		MockBroadcaster: testutil.MockBroadcaster{
			BroadcastToUsersFn: func(userIDs []string, _ ws.Event) {
				got = append([]string(nil), userIDs...)
			},
		},
		GetOnlineUserIDsForServerFn: func(_ string) []string { return online },
	}

	svc := newTestMessageService(
		&testutil.MockMessageRepo{},
		&testutil.MockAttachmentRepo{},
		channelRepo,
		&testutil.MockUserRepo{},
		&testutil.MockMentionRepo{},
		&testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{},
		&testutil.MockReactionRepo{},
		hub,
		resolver,
	)

	svc.BroadcastCreate(&models.Message{ID: "m1", ChannelID: channelID})

	want := []string{"viewer-1", "viewer-2"}
	if len(got) != len(want) {
		t.Fatalf("broadcast recipients = %v, want %v", got, want)
	}
	sort.Strings(got)
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("broadcast recipients = %v, want %v", got, want)
		}
	}

	// One channel lookup in allowedViewers, one inside the resolver, one
	// batched role query, one override query. The per-user loop this replaces
	// would have cost 1 + 3*len(online) = 13.
	if queries > 4 {
		t.Errorf("broadcast issued %d queries for %d online members, want at most 4", queries, len(online))
	}
	if queries >= 1+3*len(online) {
		t.Errorf("broadcast still scales with member count: %d queries", queries)
	}
}

// TestBroadcastCreate_DegradesToAuthorEchoOnResolveFailure pins the failure
// mode that used to be a silent no-op: when the viewer set can't be resolved
// (channel fetch / bulk resolve error), the message was persisted and the
// sender got a 201, but NOBODY received the WS event. The degraded path must
// echo to the author only (they provably have access — they just posted) and
// must NOT fall back to a server-wide broadcast, which would leak the message
// past channel permissions.
func TestBroadcastCreate_DegradesToAuthorEchoOnResolveFailure(t *testing.T) {
	channelRepo := &testutil.MockChannelRepo{
		GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return nil, errors.New("turso timeout")
		},
	}

	var usersCalls int
	var echoedTo []string
	var echoedOps []string
	hub := &testutil.MockBroadcastAndOnline{
		MockBroadcaster: testutil.MockBroadcaster{
			BroadcastToUsersFn: func(_ []string, _ ws.Event) { usersCalls++ },
			BroadcastToUserFn: func(userID string, event ws.Event) {
				echoedTo = append(echoedTo, userID)
				echoedOps = append(echoedOps, event.Op)
			},
		},
		GetOnlineUserIDsForServerFn: func(_ string) []string { return []string{"viewer-1"} },
	}

	svc := newTestMessageService(
		&testutil.MockMessageRepo{},
		&testutil.MockAttachmentRepo{},
		channelRepo,
		&testutil.MockUserRepo{},
		&testutil.MockMentionRepo{},
		&testutil.MockRoleMentionRepo{},
		&testutil.MockRoleRepo{},
		&testutil.MockReactionRepo{},
		hub,
		&testutil.MockChannelPermResolver{},
	)

	svc.BroadcastCreate(&models.Message{ID: "m1", ChannelID: "ch1", UserID: "author-1"})

	if usersCalls != 0 {
		t.Fatalf("BroadcastToUsers called %d times on resolve failure, want 0 (no permission-blind fan-out)", usersCalls)
	}
	if len(echoedTo) != 1 || echoedTo[0] != "author-1" {
		t.Fatalf("author echo recipients = %v, want exactly [author-1]", echoedTo)
	}
	if echoedOps[0] != ws.OpMessageCreate {
		t.Errorf("echo op = %q, want %q", echoedOps[0], ws.OpMessageCreate)
	}
}
