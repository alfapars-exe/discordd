package services

// First unit tests for friendshipService (Faz B, 2026-10-21). They pin the
// behaviour of the existing code: sentinel errors, repo writes, WS fan-out
// targets/payloads and the best-effort inbox write in SendRequest. The
// notification SETTLE path (MarkFriendRequestRead → notification_read) is
// covered in request_notification_test.go; here we only assert it was
// invoked with the right pair.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// sentEvent is one BroadcastToUser call captured by the fixture hub.
type sentEvent struct {
	to string
	ev ws.Event
}

// stubDMAcceptor records AcceptPendingChannels calls as "a|b" pairs.
type stubDMAcceptor struct {
	calls []string
}

type stubFriendRequestPolicy struct {
	allowed bool
	calls   [][2]string
}

func (s *stubFriendRequestPolicy) CanSend(_ context.Context, senderID, targetID string) (bool, error) {
	s.calls = append(s.calls, [2]string{senderID, targetID})
	return s.allowed, nil
}

type emailEnqueueCall struct {
	userID, category, dedupeKey, subject, body string
	options                                    EmailEnqueueOptions
}

type stubEmailEnqueuer struct {
	calls []emailEnqueueCall
	err   error
}

func (s *stubEmailEnqueuer) Enqueue(_ context.Context, userID, category, dedupeKey, subject, body string) (bool, error) {
	s.calls = append(s.calls, emailEnqueueCall{userID: userID, category: category, dedupeKey: dedupeKey, subject: subject, body: body})
	return true, s.err
}

func (s *stubEmailEnqueuer) EnqueueWithOptions(_ context.Context, userID, category, dedupeKey, subject, body string, options EmailEnqueueOptions) (bool, error) {
	s.calls = append(s.calls, emailEnqueueCall{userID: userID, category: category, dedupeKey: dedupeKey, subject: subject, body: body, options: options})
	return true, s.err
}

func (s *stubDMAcceptor) AcceptPendingChannels(_ context.Context, userA, userB string) error {
	s.calls = append(s.calls, userA+"|"+userB)
	return nil
}

type friendSvcFixture struct {
	friends  *testutil.MockFriendshipRepo
	users    *testutil.MockUserRepo
	notif    *testutil.MockNotificationRepo
	hub      *testutil.MockBroadcaster
	acceptor *stubDMAcceptor
	events   []sentEvent
	svc      FriendshipService
}

// newFriendSvcFixture wires two known users ("alice", "bob"); any other id
// or username is unknown (pkg.ErrNotFound). The friendship repo starts
// empty (every lookup → ErrNotFound) — tests set GetByPairFn/GetByIDFn.
func newFriendSvcFixture(t *testing.T) *friendSvcFixture {
	t.Helper()
	f := &friendSvcFixture{
		friends:  &testutil.MockFriendshipRepo{},
		notif:    &testutil.MockNotificationRepo{},
		hub:      &testutil.MockBroadcaster{},
		acceptor: &stubDMAcceptor{},
	}
	known := map[string]*models.User{
		"alice": {ID: "alice", Username: "alice", Status: models.UserStatusOnline},
		"bob":   {ID: "bob", Username: "bob", Status: models.UserStatusOnline},
	}
	f.users = &testutil.MockUserRepo{
		GetByIDFn: func(_ context.Context, id string) (*models.User, error) {
			if u, ok := known[id]; ok {
				cp := *u
				return &cp, nil
			}
			return nil, pkg.ErrNotFound
		},
		GetByUsernameFn: func(_ context.Context, username string) (*models.User, error) {
			if u, ok := known[username]; ok {
				cp := *u
				return &cp, nil
			}
			return nil, pkg.ErrNotFound
		},
	}
	f.hub.BroadcastToUserFn = func(userID string, e ws.Event) {
		f.events = append(f.events, sentEvent{to: userID, ev: e})
	}
	f.svc = NewFriendshipService(f.friends, f.users, f.notif, f.hub)
	f.svc.SetDMAcceptor(f.acceptor)
	return f
}

// eventsOf returns the captured events with the given op.
func (f *friendSvcFixture) eventsOf(op string) []sentEvent {
	var out []sentEvent
	for _, e := range f.events {
		if e.ev.Op == op {
			out = append(out, e)
		}
	}
	return out
}

func pendingFriendship(userID, friendID string) *models.Friendship {
	now := time.Now().UTC()
	return &models.Friendship{ID: "fr-1", UserID: userID, FriendID: friendID, Status: models.FriendshipStatusPending, CreatedAt: now, UpdatedAt: now}
}

func (f *friendSvcFixture) setPair(fr *models.Friendship) {
	f.friends.GetByPairFn = func(_ context.Context, _, _ string) (*models.Friendship, error) {
		cp := *fr
		return &cp, nil
	}
}

func (f *friendSvcFixture) setByID(fr *models.Friendship) {
	f.friends.GetByIDFn = func(_ context.Context, id string) (*models.Friendship, error) {
		if id == fr.ID {
			cp := *fr
			return &cp, nil
		}
		return nil, pkg.ErrNotFound
	}
}

func sendReq(username string) *models.SendFriendRequestRequest {
	return &models.SendFriendRequestRequest{Username: username}
}

// ─── SendRequest ───

func TestFriendshipSendRequest_Rejections(t *testing.T) {
	t.Run("target policy rejects direct API request", func(t *testing.T) {
		f := newFriendSvcFixture(t)
		enqueuer := &stubEmailEnqueuer{}
		f.svc.SetEmailEnqueuer(enqueuer)
		policy := &stubFriendRequestPolicy{allowed: false}
		f.svc = NewFriendshipService(f.friends, f.users, f.notif, f.hub, policy)
		f.svc.SetEmailEnqueuer(enqueuer)
		_, err := f.svc.SendRequest(context.Background(), "alice", sendReq("bob"))
		if !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("err = %v, want ErrForbidden", err)
		}
		if len(policy.calls) != 1 || policy.calls[0] != [2]string{"alice", "bob"} {
			t.Fatalf("policy calls = %#v", policy.calls)
		}
		if len(f.events) != 0 {
			t.Fatalf("denied request broadcast %d events", len(f.events))
		}
		if len(enqueuer.calls) != 0 {
			t.Fatalf("denied request enqueued %d emails", len(enqueuer.calls))
		}
	})

	t.Run("empty username → bad request, no lookup", func(t *testing.T) {
		f := newFriendSvcFixture(t)
		f.users.GetByUsernameFn = func(_ context.Context, _ string) (*models.User, error) {
			t.Fatal("GetByUsername must not run for an empty username")
			return nil, nil
		}
		_, err := f.svc.SendRequest(context.Background(), "alice", sendReq("   "))
		if !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatalf("err = %v, want ErrBadRequest", err)
		}
	})

	t.Run("self → bad request", func(t *testing.T) {
		f := newFriendSvcFixture(t)
		_, err := f.svc.SendRequest(context.Background(), "alice", sendReq("alice"))
		if !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatalf("err = %v, want ErrBadRequest", err)
		}
	})

	t.Run("unknown user → not found", func(t *testing.T) {
		f := newFriendSvcFixture(t)
		_, err := f.svc.SendRequest(context.Background(), "alice", sendReq("nobody"))
		if !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})

	t.Run("already accepted → already exists", func(t *testing.T) {
		f := newFriendSvcFixture(t)
		fr := pendingFriendship("alice", "bob")
		fr.Status = models.FriendshipStatusAccepted
		f.setPair(fr)
		_, err := f.svc.SendRequest(context.Background(), "alice", sendReq("bob"))
		if !errors.Is(err, pkg.ErrAlreadyExists) {
			t.Fatalf("err = %v, want ErrAlreadyExists", err)
		}
	})

	t.Run("pending same direction → already exists", func(t *testing.T) {
		f := newFriendSvcFixture(t)
		enqueuer := &stubEmailEnqueuer{}
		f.svc.SetEmailEnqueuer(enqueuer)
		f.setPair(pendingFriendship("alice", "bob"))
		_, err := f.svc.SendRequest(context.Background(), "alice", sendReq("bob"))
		if !errors.Is(err, pkg.ErrAlreadyExists) {
			t.Fatalf("err = %v, want ErrAlreadyExists", err)
		}
		if len(enqueuer.calls) != 0 {
			t.Fatalf("duplicate request enqueued %d emails", len(enqueuer.calls))
		}
	})

	// A block in EITHER direction is reported as "not found" so the sender
	// cannot probe whether they were blocked.
	for _, dir := range []struct{ name, userID, friendID string }{
		{"blocked by me", "alice", "bob"},
		{"blocked by target", "bob", "alice"},
	} {
		t.Run(dir.name+" → not found (no leak)", func(t *testing.T) {
			f := newFriendSvcFixture(t)
			fr := pendingFriendship(dir.userID, dir.friendID)
			fr.Status = models.FriendshipStatusBlocked
			f.setPair(fr)
			_, err := f.svc.SendRequest(context.Background(), "alice", sendReq("bob"))
			if !errors.Is(err, pkg.ErrNotFound) {
				t.Fatalf("err = %v, want ErrNotFound", err)
			}
			if errors.Is(err, pkg.ErrAlreadyExists) || errors.Is(err, pkg.ErrForbidden) {
				t.Fatalf("err = %v leaks the blocked state", err)
			}
			if len(f.events) != 0 {
				t.Fatalf("no WS event expected, got %+v", f.events)
			}
		})
	}
}

func TestFriendshipSendRequest_HappyPath(t *testing.T) {
	f := newFriendSvcFixture(t)
	var created *models.Friendship
	// Capture the persisted row so the email's dedupe key can be tied to it.
	enqueuer := &stubEmailEnqueuer{}
	f.svc.SetEmailEnqueuer(enqueuer)
	f.friends.CreateFn = func(_ context.Context, fr *models.Friendship) error {
		cp := *fr
		created = &cp
		return nil
	}
	var notifs []*models.Notification
	f.notif.CreateFn = func(_ context.Context, n *models.Notification) error {
		notifs = append(notifs, n)
		return nil
	}

	res, err := f.svc.SendRequest(context.Background(), "alice", sendReq("bob"))
	if err != nil {
		t.Fatalf("SendRequest: %v", err)
	}

	if created == nil {
		t.Fatal("friendRepo.Create was not called")
	}
	if len(enqueuer.calls) != 1 {
		t.Fatalf("email enqueue calls = %d, want exactly one", len(enqueuer.calls))
	}
	mail := enqueuer.calls[0]
	if mail.userID != "bob" || mail.category != models.EmailCategorySocial || mail.dedupeKey != "friend-request:"+created.ID || mail.subject != "New friend request" || mail.options.FriendshipID != created.ID || mail.options.FriendshipEvent != "request" {
		t.Errorf("email enqueue = %+v, want target bob, social category, friendship dedupe key, generic subject", mail)
	}
	if strings.Contains(mail.subject+mail.body, "alice") || strings.Contains(mail.subject+mail.body, "bob") || strings.Contains(mail.subject+mail.body, created.ID) || strings.Contains(mail.body, "private") {
		t.Errorf("email contains identity or private content: %q %q", mail.subject, mail.body)
	}
	if created.UserID != "alice" || created.FriendID != "bob" || created.Status != models.FriendshipStatusPending || created.ID == "" {
		t.Errorf("created = %+v, want pending alice→bob with an id", created)
	}

	// The caller gets the TARGET's profile on the row.
	if res.ID != created.ID || res.Status != models.FriendshipStatusPending || res.UserID != "bob" || res.Username != "bob" {
		t.Errorf("result = %+v, want id=%s pending target=bob", res, created.ID)
	}

	// The target is pushed the SENDER's profile.
	evs := f.eventsOf(ws.OpFriendRequestCreate)
	if len(evs) != 1 || evs[0].to != "bob" {
		t.Fatalf("friend_request_create events = %+v, want exactly one to bob", evs)
	}
	data, ok := evs[0].ev.Data.(models.FriendshipWithUser)
	if !ok {
		t.Fatalf("friend_request_create data type = %T, want models.FriendshipWithUser", evs[0].ev.Data)
	}
	if data.ID != created.ID || data.UserID != "alice" || data.Username != "alice" || data.Status != models.FriendshipStatusPending {
		t.Errorf("friend_request_create data = %+v, want id=%s sender=alice pending", data, created.ID)
	}

	// Inbox row for the target, then notification_create to the target.
	if len(notifs) != 1 {
		t.Fatalf("notifRepo.Create calls = %d, want 1", len(notifs))
	}
	n := notifs[0]
	if n.UserID != "bob" || n.Kind != models.NotificationKindFriendRequest || n.ActorID == nil || *n.ActorID != "alice" {
		t.Errorf("notification = %+v, want user=bob kind=friend_request actor=alice", n)
	}
	var payload map[string]string
	if err := json.Unmarshal(n.Payload, &payload); err != nil {
		t.Fatalf("payload %s is not a JSON object: %v", n.Payload, err)
	}
	if payload["friendship_id"] != created.ID || len(payload) != 1 {
		t.Errorf("payload = %s, want {\"friendship_id\":%q}", n.Payload, created.ID)
	}
	nevs := f.eventsOf(ws.OpNotificationCreate)
	if len(nevs) != 1 || nevs[0].to != "bob" {
		t.Fatalf("notification_create events = %+v, want exactly one to bob", nevs)
	}
	pushed, ok := nevs[0].ev.Data.(*models.Notification)
	if !ok || pushed != n {
		t.Errorf("notification_create data = %#v, want the same *Notification that was persisted", nevs[0].ev.Data)
	}
	if pushed != nil && (pushed.Actor == nil || pushed.Actor.ID != "alice") {
		t.Errorf("pushed notification actor = %+v, want public user alice", pushed.Actor)
	}
}

func TestFriendshipSendRequest_EmailBestEffortAndOmitsDisplayName(t *testing.T) {
	f := newFriendSvcFixture(t)
	name := `<Alice & Co>`
	f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		if id != "alice" {
			return nil, pkg.ErrNotFound
		}
		return &models.User{ID: "alice", Username: "alice", DisplayName: &name}, nil
	}
	enqueuer := &stubEmailEnqueuer{err: errors.New("sensitive transport details")}
	f.svc.SetEmailEnqueuer(enqueuer)
	res, err := f.svc.SendRequest(context.Background(), "alice", sendReq("bob"))
	if err != nil {
		t.Fatalf("email failure must not fail persisted friend request: %v", err)
	}
	if res == nil || res.Status != models.FriendshipStatusPending || len(enqueuer.calls) != 1 {
		t.Fatalf("result=%+v email calls=%d; want pending result and one attempt", res, len(enqueuer.calls))
	}
	body := enqueuer.calls[0].body
	if strings.Contains(body, name) || strings.Contains(body, "Alice") || strings.Contains(body, "alice") {
		t.Errorf("identity-rich body was queued: %q", body)
	}
}

func TestFriendshipSendRequest_EmailFallbackAndCreateFailure(t *testing.T) {
	t.Run("blank display name does not add username to generic body", func(t *testing.T) {
		f := newFriendSvcFixture(t)
		blank := "   "
		f.users.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
			if id != "alice" {
				return nil, pkg.ErrNotFound
			}
			return &models.User{ID: "alice", Username: "alice", DisplayName: &blank}, nil
		}
		enqueuer := &stubEmailEnqueuer{}
		f.svc.SetEmailEnqueuer(enqueuer)
		if _, err := f.svc.SendRequest(context.Background(), "alice", sendReq("bob")); err != nil {
			t.Fatal(err)
		}
		if len(enqueuer.calls) != 1 || strings.Contains(enqueuer.calls[0].body, "alice") {
			t.Fatalf("email calls = %+v, want generic body without username", enqueuer.calls)
		}
	})

	t.Run("failed friendship create does not enqueue", func(t *testing.T) {
		f := newFriendSvcFixture(t)
		enqueuer := &stubEmailEnqueuer{}
		f.svc.SetEmailEnqueuer(enqueuer)
		f.friends.CreateFn = func(_ context.Context, _ *models.Friendship) error { return errors.New("create failed") }
		if _, err := f.svc.SendRequest(context.Background(), "alice", sendReq("bob")); err == nil {
			t.Fatal("expected create error")
		}
		if len(enqueuer.calls) != 0 {
			t.Fatalf("email calls = %d, want zero", len(enqueuer.calls))
		}
	})
}

// The inbox write is best-effort: the request already persisted and was
// pushed, so a notifications failure must neither fail the call nor push a
// notification_create.
func TestFriendshipSendRequest_NotificationWriteIsBestEffort(t *testing.T) {
	f := newFriendSvcFixture(t)
	f.notif.CreateFn = func(_ context.Context, _ *models.Notification) error { return errors.New("db down") }

	res, err := f.svc.SendRequest(context.Background(), "alice", sendReq("bob"))
	if err != nil {
		t.Fatalf("SendRequest must not fail on a notification write error: %v", err)
	}
	if res == nil || res.UserID != "bob" {
		t.Fatalf("result = %+v, want the target row", res)
	}
	if evs := f.eventsOf(ws.OpFriendRequestCreate); len(evs) != 1 {
		t.Errorf("friend_request_create events = %+v, want exactly one", evs)
	}
	if evs := f.eventsOf(ws.OpNotificationCreate); len(evs) != 0 {
		t.Errorf("notification_create pushed after a failed write: %+v", evs)
	}
}

// Mutual request: bob already sent alice a request; alice "sending" one to
// bob auto-accepts the existing row instead of creating a second one.
func TestFriendshipSendRequest_MutualAutoAccepts(t *testing.T) {
	f := newFriendSvcFixture(t)
	enqueuer := &stubEmailEnqueuer{}
	f.svc.SetEmailEnqueuer(enqueuer)
	existing := pendingFriendship("bob", "alice") // bob → alice
	f.setPair(existing)
	f.friends.CreateFn = func(_ context.Context, _ *models.Friendship) error {
		t.Fatal("Create must not run on the mutual path")
		return nil
	}
	var updated []string
	f.friends.UpdateStatusFn = func(_ context.Context, id string, status models.FriendshipStatus) error {
		updated = append(updated, id+"="+string(status))
		return nil
	}
	f.notif.CreateFn = func(_ context.Context, _ *models.Notification) error {
		t.Fatal("notifRepo.Create must not run on the mutual path")
		return nil
	}
	var marked []string
	f.notif.MarkFriendRequestReadFn = func(_ context.Context, userID, actorID string) ([]string, error) {
		marked = append(marked, userID+"<-"+actorID)
		return []string{}, nil
	}

	res, err := f.svc.SendRequest(context.Background(), "alice", sendReq("bob"))
	if err != nil {
		t.Fatalf("SendRequest (mutual): %v", err)
	}

	if len(updated) != 1 || updated[0] != "fr-1=accepted" {
		t.Errorf("UpdateStatus calls = %v, want [fr-1=accepted]", updated)
	}
	// Original sender (bob) is told who accepted (alice).
	evs := f.eventsOf(ws.OpFriendRequestAccept)
	if len(evs) != 1 || evs[0].to != "bob" {
		t.Fatalf("friend_request_accept events = %+v, want exactly one to bob", evs)
	}
	data := evs[0].ev.Data.(models.FriendshipWithUser)
	if data.ID != "fr-1" || data.Status != models.FriendshipStatusAccepted || data.UserID != "alice" {
		t.Errorf("friend_request_accept data = %+v, want fr-1 accepted acceptor=alice", data)
	}
	if evs := f.eventsOf(ws.OpFriendRequestCreate); len(evs) != 0 {
		t.Errorf("friend_request_create must not be pushed on the mutual path: %+v", evs)
	}
	if len(marked) != 1 || marked[0] != "alice<-bob" {
		t.Errorf("MarkFriendRequestRead calls = %v, want [alice<-bob] (acceptor's row, original sender as actor)", marked)
	}
	if len(f.acceptor.calls) != 1 || f.acceptor.calls[0] != "bob|alice" {
		t.Errorf("AcceptPendingChannels calls = %v, want [bob|alice] (existing.UserID, acceptor)", f.acceptor.calls)
	}
	if len(enqueuer.calls) != 1 {
		t.Fatalf("mutual auto-accept enqueued %d emails, want accepted event", len(enqueuer.calls))
	}
	mail := enqueuer.calls[0]
	if mail.userID != "bob" || mail.dedupeKey != "friend-accepted:fr-1" || mail.options.FriendshipID != "fr-1" || mail.options.FriendshipEvent != "accepted" || strings.Contains(mail.subject+mail.body, "alice") {
		t.Errorf("mutual accepted email=%+v", mail)
	}
	// The acceptor's own result carries the ORIGINAL SENDER's profile.
	if res.ID != "fr-1" || res.Status != models.FriendshipStatusAccepted || res.UserID != "bob" || res.Username != "bob" {
		t.Errorf("result = %+v, want fr-1 accepted sender=bob", res)
	}
}

// ─── AcceptRequest ───

func TestFriendshipAcceptRequest(t *testing.T) {
	t.Run("only the recipient may accept", func(t *testing.T) {
		f := newFriendSvcFixture(t)
		f.setByID(pendingFriendship("alice", "bob"))
		if _, err := f.svc.AcceptRequest(context.Background(), "alice", "fr-1"); !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("sender accepting own request: err = %v, want ErrForbidden", err)
		}
	})

	t.Run("not pending → bad request", func(t *testing.T) {
		f := newFriendSvcFixture(t)
		fr := pendingFriendship("alice", "bob")
		fr.Status = models.FriendshipStatusAccepted
		f.setByID(fr)
		if _, err := f.svc.AcceptRequest(context.Background(), "bob", "fr-1"); !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatalf("err = %v, want ErrBadRequest", err)
		}
	})

	t.Run("failed persistence does not enqueue accepted event", func(t *testing.T) {
		f := newFriendSvcFixture(t)
		f.setByID(pendingFriendship("alice", "bob"))
		enqueuer := &stubEmailEnqueuer{}
		f.svc.SetEmailEnqueuer(enqueuer)
		f.friends.UpdateStatusFn = func(_ context.Context, _ string, _ models.FriendshipStatus) error { return errors.New("write failed") }
		if _, err := f.svc.AcceptRequest(context.Background(), "bob", "fr-1"); err == nil {
			t.Fatal("expected status write failure")
		}
		if len(enqueuer.calls) != 0 {
			t.Fatalf("failed acceptance enqueued email: %+v", enqueuer.calls)
		}
	})

	t.Run("happy path", func(t *testing.T) {
		f := newFriendSvcFixture(t)
		enqueuer := &stubEmailEnqueuer{}
		f.svc.SetEmailEnqueuer(enqueuer)
		f.setByID(pendingFriendship("alice", "bob"))
		var updated []string
		f.friends.UpdateStatusFn = func(_ context.Context, id string, status models.FriendshipStatus) error {
			updated = append(updated, id+"="+string(status))
			return nil
		}
		var marked []string
		f.notif.MarkFriendRequestReadFn = func(_ context.Context, userID, actorID string) ([]string, error) {
			marked = append(marked, userID+"<-"+actorID)
			return []string{}, nil
		}

		res, err := f.svc.AcceptRequest(context.Background(), "bob", "fr-1")
		if err != nil {
			t.Fatalf("AcceptRequest: %v", err)
		}
		if len(updated) != 1 || updated[0] != "fr-1=accepted" {
			t.Errorf("UpdateStatus calls = %v, want [fr-1=accepted]", updated)
		}
		evs := f.eventsOf(ws.OpFriendRequestAccept)
		if len(evs) != 1 || evs[0].to != "alice" {
			t.Fatalf("friend_request_accept events = %+v, want exactly one to alice (sender)", evs)
		}
		data := evs[0].ev.Data.(models.FriendshipWithUser)
		if data.ID != "fr-1" || data.Status != models.FriendshipStatusAccepted || data.UserID != "bob" {
			t.Errorf("friend_request_accept data = %+v, want fr-1 accepted acceptor=bob", data)
		}
		if len(f.acceptor.calls) != 1 || f.acceptor.calls[0] != "alice|bob" {
			t.Errorf("AcceptPendingChannels calls = %v, want [alice|bob]", f.acceptor.calls)
		}
		if len(enqueuer.calls) != 1 || enqueuer.calls[0].userID != "alice" || enqueuer.calls[0].dedupeKey != "friend-accepted:fr-1" || enqueuer.calls[0].options.FriendshipEvent != "accepted" {
			t.Errorf("accepted email=%+v, want generic notification to original requester", enqueuer.calls)
		}
		if len(marked) != 1 || marked[0] != "bob<-alice" {
			t.Errorf("MarkFriendRequestRead calls = %v, want [bob<-alice]", marked)
		}
		if res.ID != "fr-1" || res.Status != models.FriendshipStatusAccepted || res.UserID != "alice" || res.Username != "alice" {
			t.Errorf("result = %+v, want fr-1 accepted sender=alice", res)
		}
	})
}

// ─── DeclineRequest ───

func TestFriendshipDeclineRequest(t *testing.T) {
	t.Run("third party → forbidden", func(t *testing.T) {
		f := newFriendSvcFixture(t)
		f.setByID(pendingFriendship("alice", "bob"))
		if err := f.svc.DeclineRequest(context.Background(), "carol", "fr-1"); !errors.Is(err, pkg.ErrForbidden) {
			t.Fatalf("err = %v, want ErrForbidden", err)
		}
	})

	t.Run("not pending → bad request", func(t *testing.T) {
		f := newFriendSvcFixture(t)
		fr := pendingFriendship("alice", "bob")
		fr.Status = models.FriendshipStatusAccepted
		f.setByID(fr)
		if err := f.svc.DeclineRequest(context.Background(), "bob", "fr-1"); !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatalf("err = %v, want ErrBadRequest", err)
		}
	})

	// Both parties may end a pending request; the OTHER party is notified
	// and the recipient's (FriendID) inbox row is retired either way.
	for _, tc := range []struct{ name, actor, notified string }{
		{"recipient declines", "bob", "alice"},
		{"sender cancels", "alice", "bob"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFriendSvcFixture(t)
			f.setByID(pendingFriendship("alice", "bob"))
			var deleted []string
			f.friends.DeleteFn = func(_ context.Context, id string) error {
				deleted = append(deleted, id)
				return nil
			}
			var marked []string
			f.notif.MarkFriendRequestReadFn = func(_ context.Context, userID, actorID string) ([]string, error) {
				marked = append(marked, userID+"<-"+actorID)
				return []string{}, nil
			}

			if err := f.svc.DeclineRequest(context.Background(), tc.actor, "fr-1"); err != nil {
				t.Fatalf("DeclineRequest: %v", err)
			}
			if len(deleted) != 1 || deleted[0] != "fr-1" {
				t.Errorf("Delete calls = %v, want [fr-1]", deleted)
			}
			evs := f.eventsOf(ws.OpFriendRequestDecline)
			if len(evs) != 1 || evs[0].to != tc.notified {
				t.Fatalf("friend_request_decline events = %+v, want exactly one to %s", evs, tc.notified)
			}
			data, ok := evs[0].ev.Data.(map[string]string)
			if !ok || data["id"] != "fr-1" || data["user_id"] != tc.actor || len(data) != 2 {
				t.Errorf("friend_request_decline data = %#v, want {id: fr-1, user_id: %s}", evs[0].ev.Data, tc.actor)
			}
			if len(marked) != 1 || marked[0] != "bob<-alice" {
				t.Errorf("MarkFriendRequestRead calls = %v, want [bob<-alice] (recipient row, sender as actor)", marked)
			}
		})
	}
}

// ─── RemoveFriend ───

func TestFriendshipRemoveFriend(t *testing.T) {
	t.Run("no record → repo error passes through", func(t *testing.T) {
		f := newFriendSvcFixture(t)
		if err := f.svc.RemoveFriend(context.Background(), "alice", "bob"); !errors.Is(err, pkg.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})

	t.Run("not accepted → bad request", func(t *testing.T) {
		f := newFriendSvcFixture(t)
		f.setPair(pendingFriendship("alice", "bob"))
		f.friends.DeleteByPairFn = func(_ context.Context, _, _ string) error {
			t.Fatal("DeleteByPair must not run for a non-accepted record")
			return nil
		}
		if err := f.svc.RemoveFriend(context.Background(), "alice", "bob"); !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatalf("err = %v, want ErrBadRequest", err)
		}
	})

	t.Run("happy path", func(t *testing.T) {
		f := newFriendSvcFixture(t)
		fr := pendingFriendship("bob", "alice") // direction-independent
		fr.Status = models.FriendshipStatusAccepted
		f.setPair(fr)
		var deleted []string
		f.friends.DeleteByPairFn = func(_ context.Context, a, b string) error {
			deleted = append(deleted, a+"|"+b)
			return nil
		}

		if err := f.svc.RemoveFriend(context.Background(), "alice", "bob"); err != nil {
			t.Fatalf("RemoveFriend: %v", err)
		}
		if len(deleted) != 1 || deleted[0] != "alice|bob" {
			t.Errorf("DeleteByPair calls = %v, want [alice|bob]", deleted)
		}
		evs := f.eventsOf(ws.OpFriendRemove)
		if len(evs) != 1 || evs[0].to != "bob" {
			t.Fatalf("friend_remove events = %+v, want exactly one to bob", evs)
		}
		data, ok := evs[0].ev.Data.(map[string]string)
		if !ok || data["user_id"] != "alice" || len(data) != 1 {
			t.Errorf("friend_remove data = %#v, want {user_id: alice}", evs[0].ev.Data)
		}
	})
}

// ─── ListFriends / ListRequests / AreFriends ───

// A nil slice from the repo must become an empty one so the JSON body is
// `[]`, never `null` (the client iterates it without a guard).
func TestFriendshipLists_NilBecomesEmpty(t *testing.T) {
	f := newFriendSvcFixture(t)

	friends, err := f.svc.ListFriends(context.Background(), "alice")
	if err != nil {
		t.Fatalf("ListFriends: %v", err)
	}
	if friends == nil || len(friends) != 0 {
		t.Errorf("ListFriends = %#v, want empty non-nil slice", friends)
	}
	if body, _ := json.Marshal(friends); string(body) != "[]" {
		t.Errorf("ListFriends JSON = %s, want []", body)
	}

	reqs, err := f.svc.ListRequests(context.Background(), "alice")
	if err != nil {
		t.Fatalf("ListRequests: %v", err)
	}
	body, _ := json.Marshal(reqs)
	if string(body) != `{"incoming":[],"outgoing":[]}` {
		t.Errorf("ListRequests JSON = %s, want {\"incoming\":[],\"outgoing\":[]}", body)
	}
}

func TestFriendshipAreFriends(t *testing.T) {
	f := newFriendSvcFixture(t)
	ok, err := f.svc.AreFriends(context.Background(), "alice", "bob")
	if err != nil || ok {
		t.Errorf("no record: AreFriends = (%v, %v), want (false, nil)", ok, err)
	}

	f.setPair(pendingFriendship("alice", "bob"))
	ok, err = f.svc.AreFriends(context.Background(), "alice", "bob")
	if err != nil || ok {
		t.Errorf("pending: AreFriends = (%v, %v), want (false, nil)", ok, err)
	}

	fr := pendingFriendship("alice", "bob")
	fr.Status = models.FriendshipStatusAccepted
	f.setPair(fr)
	ok, err = f.svc.AreFriends(context.Background(), "alice", "bob")
	if err != nil || !ok {
		t.Errorf("accepted: AreFriends = (%v, %v), want (true, nil)", ok, err)
	}

	boom := errors.New("db down")
	f.friends.GetByPairFn = func(_ context.Context, _, _ string) (*models.Friendship, error) { return nil, boom }
	if _, err = f.svc.AreFriends(context.Background(), "alice", "bob"); !errors.Is(err, boom) {
		t.Errorf("repo error: err = %v, want boom", err)
	}
}
