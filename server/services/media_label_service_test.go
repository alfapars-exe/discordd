package services

import (
	"context"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
	"strings"
	"testing"
)

type mediaStoreStub struct {
	entry *models.MediaLabel
	calls int
	err   error
}

type mediaGroupAccessStub struct {
	repository.GroupDMRepository
	member bool
}

func (s mediaGroupAccessStub) IsMember(context.Context, string, string) (bool, error) {
	return s.member, nil
}
func (s mediaGroupAccessStub) GetMessage(context.Context, string, string) (*models.GroupDMMessage, error) {
	return &models.GroupDMMessage{ID: "m", GroupID: "source", UserID: "sender"}, nil
}
func TestMediaLabelChannelAndGroupAccess(t *testing.T) {
	for _, kind := range []string{"channel", "group"} {
		for _, allowed := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s-%v", kind, allowed), func(t *testing.T) {
				messages := &testutil.MockMessageRepo{GetByIDFn: func(context.Context, string) (*models.Message, error) {
					return &models.Message{ID: "m", ChannelID: "source", UserID: "sender"}, nil
				}}
				channels := &testutil.MockChannelRepo{GetByIDFn: func(context.Context, string) (*models.Channel, error) {
					return &models.Channel{ID: "source", ServerID: "server"}, nil
				}}
				permissions := &testutil.MockChannelPermResolver{ResolveChannelPermissionsFn: func(context.Context, string, string) (models.Permission, error) {
					if allowed {
						return models.PermViewChannel | models.PermReadMessages, nil
					}
					return models.PermViewChannel, nil
				}}
				access := NewSpamInboxService(nil, messages, channels, nil, mediaGroupAccessStub{member: allowed}, permissions)
				store := &mediaStoreStub{}
				svc := NewMediaLabelService(store, access)
				entry := &models.MediaLabel{SourceKind: kind, ChannelID: "source", MessageID: "m", Revision: "original", Fingerprint: strings.Repeat("a", 64), Label: "ordinary"}
				err := svc.Set(context.Background(), "recipient", entry)
				if allowed && (err != nil || store.calls != 1) {
					t.Fatalf("allowed err=%v calls=%d", err, store.calls)
				}
				if !allowed && (err == nil || store.calls != 0) {
					t.Fatalf("forbidden err=%v calls=%d", err, store.calls)
				}
			})
		}
	}
}

func (s *mediaStoreStub) Set(_ context.Context, e *models.MediaLabel) error {
	s.calls++
	copy := *e
	s.entry = &copy
	return s.err
}
func (s *mediaStoreStub) Get(_ context.Context, e *models.MediaLabel) (*models.MediaLabel, error) {
	s.calls++
	s.entry = e
	return e, s.err
}
func (s *mediaStoreStub) Delete(_ context.Context, e *models.MediaLabel) error {
	s.calls++
	s.entry = e
	return s.err
}

type mediaReferenceAccessStub struct{}

func (mediaReferenceAccessStub) RecipientRevision(context.Context, string, string, string, string) (string, error) {
	return "original", nil
}

func TestMediaLabelInvalidatesOnlyOwnerAfterSuccessfulCommit(t *testing.T) {
	for _, remove := range []bool{false, true} {
		for _, fail := range []bool{false, true} {
			store := &mediaStoreStub{}
			if fail {
				store.err = errors.New("storage unavailable")
			}
			svc := NewMediaLabelService(store, mediaReferenceAccessStub{})
			calls := 0
			hub := &testutil.MockBroadcaster{
				BroadcastToAllFn:    func(ws.Event) { t.Fatal("public broadcast") },
				BroadcastToServerFn: func(string, ws.Event) { t.Fatal("server broadcast") },
				BroadcastToUsersFn:  func([]string, ws.Event) { t.Fatal("multiple-owner broadcast") },
				BroadcastToUserFn: func(owner string, event ws.Event) {
					calls++
					if owner != "owner" || store.calls != 1 || event.Op != "media_label_changed" {
						t.Fatalf("event before commit or wrong owner: %s %+v", owner, event)
					}
					data := event.Data.(map[string]string)
					if len(data) != 6 || data["user_id"] != owner || data["message_id"] != "m" || data["fingerprint"] != strings.Repeat("a", 64) {
						t.Fatalf("unexpected event: %+v", data)
					}
				},
			}
			svc.SetBroadcaster(hub)
			entry := &models.MediaLabel{UserID: "forged", SourceKind: "dm", ChannelID: "source", MessageID: "m", Revision: "original", Fingerprint: strings.Repeat("a", 64), Label: "ordinary"}
			var err error
			if remove {
				err = svc.Delete(context.Background(), "owner", entry)
			} else {
				err = svc.Set(context.Background(), "owner", entry)
			}
			if (err != nil) != fail || calls != map[bool]int{false: 1, true: 0}[fail] {
				t.Fatalf("remove=%v fail=%v err=%v broadcasts=%d", remove, fail, err, calls)
			}
		}
	}
}
func TestMediaLabelSourceAuthorizationAndOwnerBinding(t *testing.T) {
	for _, tc := range []struct {
		name, user, channel, revision string
		want                          error
	}{{"recipient", "recipient", "private", "original", nil}, {"foreign", "stranger", "private", "original", pkg.ErrNotFound}, {"wrong channel", "recipient", "wrong", "original", pkg.ErrNotFound}, {"own", "sender", "private", "original", pkg.ErrBadRequest}, {"stale", "recipient", "private", "2026-10-24T12:00:00Z", pkg.ErrConflict}} {
		t.Run(tc.name, func(t *testing.T) {
			dms := &testutil.MockDMRepo{GetMessageByIDFn: func(context.Context, string) (*models.DMMessage, error) {
				return &models.DMMessage{ID: "m", DMChannelID: "private", UserID: "sender"}, nil
			}, GetChannelByIDFn: func(context.Context, string) (*models.DMChannel, error) {
				return &models.DMChannel{ID: "private", User1ID: "sender", User2ID: "recipient"}, nil
			}}
			store := &mediaStoreStub{}
			access := NewSpamInboxService(nil, nil, nil, dms, nil, nil)
			service := NewMediaLabelService(store, access)
			entry := &models.MediaLabel{UserID: "forged", SourceKind: "dm", ChannelID: tc.channel, MessageID: "m", Revision: tc.revision, Fingerprint: strings.Repeat("a", 64), Label: "both"}
			err := service.Set(context.Background(), tc.user, entry)
			if !errors.Is(err, tc.want) {
				t.Fatalf("err=%v want=%v", err, tc.want)
			}
			if tc.want != nil && store.calls != 0 {
				t.Fatal("unauthorized storage call")
			}
			if tc.want == nil && (store.entry.UserID != tc.user || entry.UserID != "forged") {
				t.Fatal("owner not bound without mutating input")
			}
		})
	}
}
func TestMediaLabelDeleteOwnReferenceWithoutSourceAccess(t *testing.T) {
	store := &mediaStoreStub{}
	service := NewMediaLabelService(store, nil)
	entry := &models.MediaLabel{UserID: "foreign", SourceKind: "group", ChannelID: "g", MessageID: "m", Revision: "original", Fingerprint: strings.Repeat("a", 64)}
	if err := service.Delete(context.Background(), "owner", entry); err != nil {
		t.Fatal(err)
	}
	if store.entry.UserID != "owner" {
		t.Fatal("foreign deletion")
	}
}
