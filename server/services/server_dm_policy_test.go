package services

import (
	"context"
	"testing"
)

type serverListStub map[string][]string

func (s serverListStub) GetMemberServerIDs(_ context.Context, userID string) ([]string, error) {
	return s[userID], nil
}

func TestServerDMPolicyDefaultsAndOverrides(t *testing.T) {
	tests := []struct {
		name, data string
		want       bool
	}{
		{"legacy default allows", `{}`, true},
		{"default denies", `{"privacy":{"serverDMDefault":false}}`, false},
		{"matching override allows", `{"privacy":{"serverDMDefault":false,"serverDMOverrides":{"shared":true}}}`, true},
		{"matching override denies", `{"privacy":{"serverDMDefault":true,"serverDMOverrides":{"shared":false}}}`, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			policy := NewServerDMPolicy(friendRequestPrefsStub{tc.data}, serverListStub{"sender": {"shared"}, "target": {"shared"}})
			got, err := policy.CanCreate(context.Background(), "sender", "target")
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("CanCreate=%v want %v", got, tc.want)
			}
		})
	}
}

func TestServerDMPolicyDoesNotApplyWithoutSharedServer(t *testing.T) {
	policy := NewServerDMPolicy(friendRequestPrefsStub{`{"privacy":{"serverDMDefault":false}}`}, serverListStub{"sender": {"a"}, "target": {"b"}})
	got, err := policy.CanCreate(context.Background(), "sender", "target")
	if err != nil || !got {
		t.Fatalf("CanCreate=%v err=%v", got, err)
	}
}
