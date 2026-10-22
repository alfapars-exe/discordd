package services

// Inbox notifications written by messageService.Create (mention / reply
// rows, permission gate, E2EE metadata mentions) and the preview helper.
// Fixture shape mirrors message_service_test.go's passthroughTxRunner.

import (
	"context"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// notificationCreateFixture wires Create with a mention-capable user repo
// and a per-user permission resolver, capturing every notification row and
// every notification_create broadcast. Users not in perms can read.
func notificationCreateFixture(t *testing.T, perms map[string]models.Permission) (svc MessageService, rows *[]*models.Notification, pushed *[]string) {
	t.Helper()
	var created []*models.Notification
	var broadcastTo []string
	notifRepo := &testutil.MockNotificationRepo{
		CreateFn: func(_ context.Context, n *models.Notification) error {
			n.ID = "notif-" + n.UserID
			cp := *n
			created = append(created, &cp)
			return nil
		},
	}
	msgRepo := &testutil.MockMessageRepo{
		CreateFn: func(_ context.Context, m *models.Message) error { m.ID = "m-new"; return nil },
		GetByIDFn: func(_ context.Context, id string) (*models.Message, error) {
			if id == "m-ref" {
				return &models.Message{ID: "m-ref", ChannelID: "ch1", UserID: "replied"}, nil
			}
			return nil, pkg.ErrNotFound
		},
	}
	mentionRepo := &testutil.MockMentionRepo{}
	roleMentionRepo := &testutil.MockRoleMentionRepo{}
	runner := passthroughTxRunner{repos: repository.MessageTxRepos{
		Message: msgRepo, Mention: mentionRepo, RoleMention: roleMentionRepo,
		ReadState: noopReadStateRepo{}, Notification: notifRepo,
	}}
	hub := &testutil.MockBroadcastAndOnline{
		MockBroadcaster: testutil.MockBroadcaster{
			BroadcastToUserFn: func(userID string, e ws.Event) {
				if e.Op == ws.OpNotificationCreate {
					broadcastTo = append(broadcastTo, userID)
				}
			},
		},
	}
	svc = NewMessageService(
		msgRepo, &testutil.MockAttachmentRepo{},
		&testutil.MockChannelRepo{GetByIDFn: func(_ context.Context, _ string) (*models.Channel, error) {
			return &models.Channel{ID: "ch1", ServerID: "srv1", Name: "genel"}, nil
		}},
		&testutil.MockUserRepo{GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
			if id == "nobody" {
				return nil, pkg.ErrNotFound
			}
			return &models.User{ID: id, Username: id}, nil
		}},
		mentionRepo, roleMentionRepo, &testutil.MockRoleRepo{}, &testutil.MockReactionRepo{},
		noopReadStateRepo{}, noopTimeoutRepo{}, runner, hub,
		&testutil.MockChannelPermResolver{
			ResolveChannelPermissionsFn: func(_ context.Context, userID, _ string) (models.Permission, error) {
				if p, ok := perms[userID]; ok {
					return p, nil
				}
				return models.PermSendMessages | models.PermReadMessages | models.PermViewChannel, nil
			},
		},
		nil, notifRepo,
	)
	return svc, &created, &broadcastTo
}

// TestMessageCreate_WritesMentionAndReplyNotifications: one 'mention' per
// mentioned user (author excluded), one 'reply' for the replied-to author
// when not already mentioned, each pushed post-commit to its target only.
func TestMessageCreate_WritesMentionAndReplyNotifications(t *testing.T) {
	svc, rows, pushed := notificationCreateFixture(t, nil)
	replyTo := "m-ref"
	msg, err := svc.Create(context.Background(), "srv1", "ch1", "author", &models.CreateMessageRequest{
		Content:   "hey <@bob> and <@author> look at this",
		ReplyToID: &replyTo,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if len(*rows) != 2 {
		t.Fatalf("notifications = %d, want 2 (mention bob + reply replied): %+v", len(*rows), *rows)
	}
	byKind := map[string]*models.Notification{}
	for _, n := range *rows {
		byKind[n.Kind] = n
	}
	m := byKind[models.NotificationKindMention]
	if m == nil || m.UserID != "bob" || *m.ActorID != "author" || *m.MessageID != msg.ID || *m.ChannelID != "ch1" || *m.ServerID != "srv1" {
		t.Errorf("mention row = %+v", m)
	}
	if string(m.Payload) != `{"preview":"hey <@bob> and <@author> look at this","channel_name":"genel"}` {
		t.Errorf("mention payload = %s", m.Payload)
	}
	r := byKind[models.NotificationKindReply]
	if r == nil || r.UserID != "replied" {
		t.Errorf("reply row = %+v", r)
	}
	if len(*pushed) != 2 || (*pushed)[0] != "bob" || (*pushed)[1] != "replied" {
		t.Errorf("notification_create pushed to %v, want [bob replied]", *pushed)
	}
}

// TestMessageCreate_ReplyTargetAlreadyMentionedGetsOneRow — a reply whose
// author is also @-mentioned gets a single 'mention' row, never both.
func TestMessageCreate_ReplyTargetAlreadyMentionedGetsOneRow(t *testing.T) {
	svc, rows, _ := notificationCreateFixture(t, nil)
	replyTo := "m-ref"
	if _, err := svc.Create(context.Background(), "srv1", "ch1", "author", &models.CreateMessageRequest{
		Content: "<@replied> yes", ReplyToID: &replyTo,
	}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if len(*rows) != 1 || (*rows)[0].Kind != models.NotificationKindMention || (*rows)[0].UserID != "replied" {
		t.Errorf("rows = %+v, want exactly one mention for replied", *rows)
	}
}

// TestMessageCreate_NotificationTargetMustReadChannel — a mentioned user
// without ViewChannel+ReadMessages gets no row (no channel-name/preview leak).
func TestMessageCreate_NotificationTargetMustReadChannel(t *testing.T) {
	svc, rows, pushed := notificationCreateFixture(t, map[string]models.Permission{
		"blind": models.PermSendMessages, // no ViewChannel / ReadMessages
	})
	if _, err := svc.Create(context.Background(), "srv1", "ch1", "author", &models.CreateMessageRequest{
		Content: "<@blind> <@bob>",
	}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if len(*rows) != 1 || (*rows)[0].UserID != "bob" {
		t.Errorf("rows = %+v, want only bob", *rows)
	}
	if len(*pushed) != 1 || (*pushed)[0] != "bob" {
		t.Errorf("pushed = %v, want [bob]", *pushed)
	}
}

// TestMessageCreate_E2EEMentionsFromMetadata — an E2EE message declares
// its mention targets in e2ee_metadata; they get mention rows (null
// preview) AND message_mentions rows, with malformed/unknown ids dropped.
func TestMessageCreate_E2EEMentionsFromMetadata(t *testing.T) {
	svc, rows, _ := notificationCreateFixture(t, nil)
	cipher, device := "blob", "dev1"
	meta := `{"mention_user_ids":["bob","nobody","BAD-ID!","bob","author"]}`
	msg, err := svc.Create(context.Background(), "srv1", "ch1", "author", &models.CreateMessageRequest{
		EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device, E2EEMetadata: &meta,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// author is a valid message_mentions target (self-mention is stored
	// there, as for plaintext) but never gets an inbox row.
	if len(msg.Mentions) != 2 || msg.Mentions[0] != "bob" || msg.Mentions[1] != "author" {
		t.Errorf("Mentions = %v, want [bob author] (dedup, invalid + unknown dropped)", msg.Mentions)
	}
	if len(msg.RoleMentions) != 0 {
		t.Errorf("RoleMentions = %v, want empty for E2EE", msg.RoleMentions)
	}
	if len(*rows) != 1 || (*rows)[0].UserID != "bob" {
		t.Fatalf("rows = %+v, want one mention row for bob", *rows)
	}
	if string((*rows)[0].Payload) != `{"preview":null,"channel_name":"genel"}` {
		t.Errorf("E2EE payload = %s, want null preview", (*rows)[0].Payload)
	}

	// Malformed metadata degrades to "no mentions", never an error.
	bad := `{"mention_user_ids": "not-a-list"`
	msg, err = svc.Create(context.Background(), "srv1", "ch1", "author", &models.CreateMessageRequest{
		EncryptionVersion: 1, Ciphertext: &cipher, SenderDeviceID: &device, E2EEMetadata: &bad,
	})
	if err != nil {
		t.Fatalf("Create(malformed metadata): %v", err)
	}
	if len(msg.Mentions) != 0 {
		t.Errorf("Mentions from malformed metadata = %v, want none", msg.Mentions)
	}
}

func TestNotificationPreview_TruncatesTo120Runes(t *testing.T) {
	if notificationPreview("  \n ") != nil {
		t.Error("blank body should yield nil preview")
	}
	long := strings.Repeat("ğ", 130)
	got := notificationPreview(long)
	if got == nil || len([]rune(*got)) != notificationPreviewMaxRunes || !strings.HasSuffix(*got, "…") {
		t.Fatalf("preview of 130 runes = %v, want exactly %d runes including the ellipsis", got, notificationPreviewMaxRunes)
	}
	exact := strings.Repeat("x", notificationPreviewMaxRunes)
	if p := notificationPreview(exact); p == nil || *p != exact {
		t.Errorf("a body of exactly %d runes must pass through untouched", notificationPreviewMaxRunes)
	}
	multi := notificationPreview("a\r\nb")
	if multi == nil || *multi != "a  b" {
		t.Fatalf("newline collapse = %v", multi)
	}
}
