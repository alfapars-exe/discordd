package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/ws"
)

func TestJoinServerBroadcastLookupFailuresRemainBestEffort(t *testing.T) {
	for _, userLookupFails := range []bool{true, false} {
		name := "role lookup fails"
		if userLookupFails {
			name = "user lookup fails"
		}
		t.Run(name, func(t *testing.T) {
			checkJoinBroadcastLookupFailure(t, userLookupFails)
		})
	}
}

func checkJoinBroadcastLookupFailure(t *testing.T, userLookupFails bool) {
	t.Helper()
	h := newJoinServerHarness()
	roleCalls, broadcasts := 0, 0
	h.userRepo.GetByIDFn = func(context.Context, string) (*models.User, error) {
		if userLookupFails {
			return nil, errors.New("user lookup failed")
		}
		bio := "private profile"
		return &models.User{ID: joinTestUserID, Bio: &bio}, nil
	}
	h.roleRepo.GetByUserIDAndServerFn = func(context.Context, string, string) ([]models.Role, error) {
		roleCalls++
		return nil, errors.New("role lookup failed")
	}
	h.hub.BroadcastToServerFn = func(_ string, event ws.Event) {
		if event.Op != ws.OpMemberJoin {
			return
		}
		broadcasts++
		member := event.Data.(models.MemberWithRoles)
		if member.Bio != nil || !member.ProfileFieldsRedacted {
			t.Fatal("best-effort broadcast exposed profile fields")
		}
	}
	if server, err := h.svc.JoinServer(context.Background(), joinTestUserID, joinTestCode); err != nil || server == nil {
		t.Fatalf("committed join failed: server=%v err=%v", server, err)
	}
	want := 1
	if userLookupFails {
		want = 0
	}
	if roleCalls != want || broadcasts != want {
		t.Fatalf("role calls/broadcasts=%d/%d, want %d/%d", roleCalls, broadcasts, want, want)
	}
}
