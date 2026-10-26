package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

func TestSendMessageServerDMPolicyForEmptyChannel(t *testing.T) {
	tests := []struct {
		name                            string
		preferences                     string
		senderHistory, recipientHistory int
		friends, admin, self            bool
		countError                      bool
		wantDenied                      bool
	}{
		{name: "previously opened empty channel denied", preferences: `{"privacy":{"serverDMDefault":false}}`, wantDenied: true},
		{name: "server override denies", preferences: `{"privacy":{"serverDMDefault":true,"serverDMOverrides":{"shared":false,"second":false}}}`, wantDenied: true},
		{name: "server override allows", preferences: `{"privacy":{"serverDMDefault":false,"serverDMOverrides":{"shared":true}}}`},
		{name: "another shared server allows", preferences: `{"privacy":{"serverDMDefault":false,"serverDMOverrides":{"second":true}}}`},
		{name: "sender history preserved", preferences: `{"privacy":{"serverDMDefault":false}}`, senderHistory: 1},
		{name: "recipient history preserved", preferences: `{"privacy":{"serverDMDefault":false}}`, recipientHistory: 1},
		{name: "friends bypass", preferences: `{"privacy":{"serverDMDefault":false}}`, friends: true},
		{name: "platform admin bypass", preferences: `{"privacy":{"serverDMDefault":false}}`, admin: true},
		{name: "self notes bypass", preferences: `{"privacy":{"serverDMDefault":false}}`, self: true},
		{name: "history lookup fails closed", preferences: `{}`, countError: true, wantDenied: true},
		{name: "invalid preferences fail closed", preferences: `{`, wantDenied: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newDMFixture()
			recipient := "bob"
			if tc.self {
				recipient = "alice"
			}
			f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
				return &models.DMChannel{ID: id, User1ID: "alice", User2ID: recipient, Status: models.DMStatusAccepted}, nil
			}
			f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
				return &models.User{ID: id, IsPlatformAdmin: id == "alice" && tc.admin}, nil
			}
			f.friends.AreFriendsFn = func(context.Context, string, string) (bool, error) { return tc.friends, nil }
			f.repo.HasMessagesFn = func(context.Context, string) (bool, error) {
				if tc.countError {
					return false, errors.New("history unavailable")
				}
				return tc.senderHistory > 0 || tc.recipientHistory > 0, nil
			}
			f.svc.(*dmService).SetServerDMPolicy(NewServerDMPolicy(friendRequestPrefsStub{tc.preferences}, serverListStub{
				"alice": {"shared", "second"}, "bob": {"shared", "second"},
			}))
			writes := 0
			broadcasts := 0
			otherWrites := 0
			f.hub.BroadcastToUserFn = func(string, ws.Event) { broadcasts++ }
			f.dmRead.IncrementUnreadFn = func(context.Context, string, string) error { otherWrites++; return nil }
			f.repo.TransitionToPendingFn = func(context.Context, string, string) error { otherWrites++; return nil }
			f.notif.CreateFn = func(context.Context, *models.Notification) error { otherWrites++; return nil }
			f.repo.CreateMessageFn = func(context.Context, *models.DMMessage) error { writes++; return nil }
			_, err := f.svc.SendMessage(context.Background(), "alice", "channel", &models.CreateDMMessageRequest{Content: "hello"})
			if tc.wantDenied {
				if err == nil || writes != 0 || otherWrites != 0 {
					t.Fatalf("err=%v message writes=%d other writes=%d; denied send must not persist", err, writes, otherWrites)
				}
				if !tc.countError && tc.preferences != `{` && !errors.Is(err, pkg.ErrForbidden) {
					t.Fatalf("expected forbidden, got %v", err)
				}
				if broadcasts > 0 {
					t.Fatal("denied send broadcast an event")
				}
			} else if err != nil || writes != 1 {
				t.Fatalf("err=%v writes=%d; expected permitted send", err, writes)
			}
		})
	}
}

type dmTxPolicyPreferences struct {
	repository.PreferencesRepository
	friendRequestPrefsStub
}

func (p dmTxPolicyPreferences) Get(ctx context.Context, id string) (*models.UserPreferences, error) {
	return p.friendRequestPrefsStub.Get(ctx, id)
}

func TestSendMessageRechecksPolicyAndPendingAfterChannelLock(t *testing.T) {
	for _, pending := range []bool{false, true} {
		name := "preferences changed after preflight"
		if pending {
			name = "another first message made channel pending"
		}
		t.Run(name, func(t *testing.T) {
			f := newDMFixture()
			locked := false
			f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
				ch := &models.DMChannel{ID: id, User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted}
				if locked && pending {
					ch.Status = models.DMStatusPending
					ch.InitiatedBy = strPtr("alice")
				}
				return ch, nil
			}
			f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) { return &models.User{ID: id}, nil }
			s := f.svc.(*dmService)
			s.SetServerDMPolicy(NewServerDMPolicy(friendRequestPrefsStub{`{}`}, serverListStub{"alice": {"shared"}, "bob": {"shared"}}))
			writes := 0
			f.repo.CreateMessageFn = func(context.Context, *models.DMMessage) error { writes++; return nil }
			prefLocked := false
			servers := &testutil.MockServerRepo{GetMemberServerIDsFn: func(context.Context, string) ([]string, error) { return []string{"shared"}, nil }}
			s.txRunner = passthroughDMTxRunner{repos: repository.DMTxRepos{
				DM: f.repo, DMRead: f.dmRead, Notification: f.notif,
				LockChannel:     func(context.Context, string) error { locked = true; return nil },
				LockPreferences: func(context.Context, string) error { prefLocked = true; return nil },
				Preferences:     dmTxPolicyPreferences{friendRequestPrefsStub: friendRequestPrefsStub{`{"privacy":{"serverDMDefault":false}}`}}, Servers: servers,
			}}
			_, err := s.SendMessage(context.Background(), "alice", "channel", &models.CreateDMMessageRequest{Content: "hello"})
			if !errors.Is(err, pkg.ErrForbidden) || writes != 0 {
				t.Fatalf("err=%v writes=%d", err, writes)
			}
			if !pending && !prefLocked {
				t.Fatal("authoritative policy read did not lock preferences")
			}
		})
	}
}

func TestSendMessageHistoryCheckAfterLockUsesSingleExistenceQuery(t *testing.T) {
	f := newDMFixture()
	f.repo.GetChannelByIDFn = func(_ context.Context, id string) (*models.DMChannel, error) {
		return &models.DMChannel{ID: id, User1ID: "alice", User2ID: "bob", Status: models.DMStatusAccepted}, nil
	}
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) { return &models.User{ID: id}, nil }
	locked, checks := false, 0
	f.repo.HasMessagesFn = func(context.Context, string) (bool, error) { checks++; return locked, nil }
	f.repo.CountMessagesBySenderFn = func(context.Context, string, string) (int, error) {
		t.Fatal("server policy scanned sender history")
		return 0, nil
	}
	s := f.svc.(*dmService)
	s.SetServerDMPolicy(NewServerDMPolicy(friendRequestPrefsStub{`{}`}, serverListStub{"alice": {"shared"}, "bob": {"shared"}}))
	s.txRunner = passthroughDMTxRunner{repos: repository.DMTxRepos{
		DM: f.repo, DMRead: f.dmRead, Notification: f.notif,
		LockChannel: func(context.Context, string) error { locked = true; return nil },
		LockPreferences: func(context.Context, string) error {
			t.Fatal("established history should bypass policy preferences")
			return nil
		},
		Preferences: dmTxPolicyPreferences{friendRequestPrefsStub: friendRequestPrefsStub{`{"privacy":{"serverDMDefault":false}}`}},
		Servers:     &testutil.MockServerRepo{},
	}}
	if _, err := s.SendMessage(context.Background(), "alice", "channel", &models.CreateDMMessageRequest{Content: "hello"}); err != nil {
		t.Fatal(err)
	}
	if checks != 2 {
		t.Fatalf("history checks=%d want one preflight and one transactional", checks)
	}
}
