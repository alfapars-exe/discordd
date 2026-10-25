package services

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/argeinfina/hichat/models"
)

type friendRequestPrefsStub struct{ data string }

type changingFriendRequestPrefs struct{ reads int }

func (s *changingFriendRequestPrefs) Get(context.Context, string) (*models.UserPreferences, error) {
	s.reads++
	data := `{"privacy":{"friendRequests":{"everyone":false,"server":true},"serverDMDefault":false}}`
	if s.reads > 1 {
		data = `{"privacy":{"friendRequests":{"everyone":false,"server":false},"serverDMDefault":true}}`
	}
	return &models.UserPreferences{Data: json.RawMessage(data)}, nil
}

func TestFriendRequestPolicy_UsesOnePreferenceSnapshot(t *testing.T) {
	prefs := &changingFriendRequestPrefs{}
	policy := NewFriendRequestPolicy(prefs, nil, nil, friendRequestServersStub{map[string][]string{"sender": {"shared"}, "target": {"shared"}}})
	allowed, err := policy.CanSend(context.Background(), "sender", "target")
	if err != nil || allowed || prefs.reads != 1 {
		t.Fatalf("mixed preference snapshots: allowed=%v reads=%d err=%v", allowed, prefs.reads, err)
	}
}

func (s friendRequestPrefsStub) Get(context.Context, string) (*models.UserPreferences, error) {
	return &models.UserPreferences{Data: json.RawMessage(s.data)}, nil
}

type friendRequestServersStub struct{ byUser map[string][]string }

func (s friendRequestServersStub) GetMemberServerIDs(_ context.Context, userID string) ([]string, error) {
	return s.byUser[userID], nil
}

func TestFriendRequestPolicy_DefaultAndEveryone(t *testing.T) {
	for _, data := range []string{`{}`, `{"privacy":{"friendRequests":{"everyone":true,"mutual":false,"server":false}}}`} {
		policy := NewFriendRequestPolicy(friendRequestPrefsStub{data}, func(context.Context, string) ([]string, error) {
			return nil, nil
		}, func(context.Context, string, string) (bool, error) { return false, nil }, friendRequestServersStub{})
		allowed, err := policy.CanSend(context.Background(), "sender", "target")
		if err != nil || !allowed {
			t.Fatalf("data=%s allowed=%v err=%v", data, allowed, err)
		}
	}
}

func TestFriendRequestPolicy_MutualFriend(t *testing.T) {
	policy := NewFriendRequestPolicy(
		friendRequestPrefsStub{`{"privacy":{"friendRequests":{"everyone":false,"mutual":true,"server":false}}}`},
		func(context.Context, string) ([]string, error) { return []string{"not-mutual", "shared-friend"}, nil },
		func(_ context.Context, _ string, candidate string) (bool, error) {
			return candidate == "shared-friend", nil
		},
		friendRequestServersStub{},
	)
	allowed, err := policy.CanSend(context.Background(), "sender", "target")
	if err != nil || !allowed {
		t.Fatalf("allowed=%v err=%v", allowed, err)
	}
}

func TestFriendRequestPolicy_CommonServerAndDeny(t *testing.T) {
	data := `{"privacy":{"friendRequests":{"everyone":false,"mutual":false,"server":true}}}`
	makePolicy := func(servers map[string][]string) FriendRequestPolicy {
		return NewFriendRequestPolicy(friendRequestPrefsStub{data}, func(context.Context, string) ([]string, error) {
			return nil, nil
		}, func(context.Context, string, string) (bool, error) { return false, nil }, friendRequestServersStub{servers})
	}
	allowed, err := makePolicy(map[string][]string{"sender": {"a", "shared"}, "target": {"shared"}}).CanSend(context.Background(), "sender", "target")
	if err != nil || !allowed {
		t.Fatalf("common server allowed=%v err=%v", allowed, err)
	}
	allowed, err = makePolicy(map[string][]string{"sender": {"a"}, "target": {"b"}}).CanSend(context.Background(), "sender", "target")
	if err != nil || allowed {
		t.Fatalf("disjoint servers allowed=%v err=%v", allowed, err)
	}
}
