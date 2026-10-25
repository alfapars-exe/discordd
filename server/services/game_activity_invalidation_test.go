package services

import (
	"context"
	"testing"

	"github.com/argeinfina/hichat/models"
)

type gameActivityInvalidationCall struct {
	kind, a, b string
}

type recordingGameActivityInvalidator struct {
	calls []gameActivityInvalidationCall
}

func (r *recordingGameActivityInvalidator) PolicyChanged(context.Context, string) {}
func (r *recordingGameActivityInvalidator) RelationshipChanged(_ context.Context, a, b string) {
	r.calls = append(r.calls, gameActivityInvalidationCall{kind: "relationship", a: a, b: b})
}
func (r *recordingGameActivityInvalidator) MembershipAdded(_ context.Context, serverID, userID string) {
	r.calls = append(r.calls, gameActivityInvalidationCall{kind: "added", a: serverID, b: userID})
}
func (r *recordingGameActivityInvalidator) MembershipRemoved(_ context.Context, serverID, userID string) {
	r.calls = append(r.calls, gameActivityInvalidationCall{kind: "removed", a: serverID, b: userID})
}
func (r *recordingGameActivityInvalidator) ServerDeleted(_ context.Context, serverID string) {
	r.calls = append(r.calls, gameActivityInvalidationCall{kind: "deleted", a: serverID})
}

func TestBlockAndUnblockImmediatelyInvalidateGameActivityRelationship(t *testing.T) {
	f := newBlockSvcFixture(t)
	invalidator := &recordingGameActivityInvalidator{}
	f.svc.(*blockService).SetGameActivityPrivacyInvalidator(invalidator)
	if err := f.svc.BlockUser(context.Background(), "alice", "bob"); err != nil {
		t.Fatal(err)
	}
	if len(invalidator.calls) != 1 || invalidator.calls[0] != (gameActivityInvalidationCall{kind: "relationship", a: "alice", b: "bob"}) {
		t.Fatalf("block invalidation = %+v", invalidator.calls)
	}

	f.setPair(friendshipRow("alice", "bob", models.FriendshipStatusBlocked))
	f.friends.DeleteFn = func(context.Context, string) error { return nil }
	if err := f.svc.UnblockUser(context.Background(), "alice", "bob"); err != nil {
		t.Fatal(err)
	}
	if len(invalidator.calls) != 2 || invalidator.calls[1] != (gameActivityInvalidationCall{kind: "relationship", a: "alice", b: "bob"}) {
		t.Fatalf("unblock invalidation = %+v", invalidator.calls)
	}
}

func TestFriendshipAcceptAndRemoveImmediatelyInvalidateGameActivityRelationship(t *testing.T) {
	f := newFriendSvcFixture(t)
	invalidator := &recordingGameActivityInvalidator{}
	f.svc.(*friendshipService).SetGameActivityPrivacyInvalidator(invalidator)
	f.setByID(pendingFriendship("alice", "bob"))
	f.friends.UpdateStatusFn = func(context.Context, string, models.FriendshipStatus) error { return nil }
	f.notif.MarkFriendRequestReadFn = func(context.Context, string, string) ([]string, error) { return nil, nil }
	if _, err := f.svc.AcceptRequest(context.Background(), "bob", "fr-1"); err != nil {
		t.Fatal(err)
	}
	if len(invalidator.calls) != 1 || invalidator.calls[0] != (gameActivityInvalidationCall{kind: "relationship", a: "alice", b: "bob"}) {
		t.Fatalf("accept invalidation = %+v", invalidator.calls)
	}

	accepted := friendshipRow("alice", "bob", models.FriendshipStatusAccepted)
	f.setPair(accepted)
	f.friends.DeleteByPairFn = func(context.Context, string, string) error { return nil }
	if err := f.svc.RemoveFriend(context.Background(), "alice", "bob"); err != nil {
		t.Fatal(err)
	}
	if len(invalidator.calls) != 2 || invalidator.calls[1] != (gameActivityInvalidationCall{kind: "relationship", a: "alice", b: "bob"}) {
		t.Fatalf("remove invalidation = %+v", invalidator.calls)
	}
}

func TestGameActivityMembershipRemovedIsIdempotentForUnknownViewerGrant(t *testing.T) {
	svc := NewGameActivityService(&activityPolicyStub{}, nil, nil, nil)
	// No grants are present; a committed removal still reconciles the target
	// safely and must not panic on missing optional readers.
	svc.MembershipRemoved(context.Background(), "server", "user")
}
