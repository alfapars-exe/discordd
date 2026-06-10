// Member service tests — cover the moderation flows (Timeout / RemoveTimeout
// / Ban / Unban) and the MemberWithRoles.TimeoutExpiresAt population that
// makes the "geçici sustur / yasakla" UI work.
//
// Pattern follows auth_service_test.go and message_service_test.go: a
// helper constructor wires hand-rolled mocks from testutil, then each
// test case overrides only the Fn fields it cares about. Broadcasts
// are captured via MockEventPublisher.BroadcastToServerFn (the same
// mock satisfies both BroadcastAndManage subset interfaces we need).

package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
	"github.com/argeinfina/hichat/ws"
)

// memberServiceHarness bundles the mocks so tests can poke any of them
// after wiring. Keeps the constructor signature short and lets us
// inspect captured broadcasts via the same struct.
type memberServiceHarness struct {
	svc         MemberService
	userRepo    *testutil.MockUserRepo
	roleRepo    *testutil.MockRoleRepo
	banRepo     *testutil.MockBanRepo
	timeoutRepo *testutil.MockMemberTimeoutRepo
	serverRepo  *testutil.MockServerRepo
	hub         *testutil.MockEventPublisher
	voiceKick   *testutil.MockVoiceDisconnecter
	broadcasts  []ws.Event // captured server broadcasts (in order)
}

func newMemberHarness() *memberServiceHarness {
	h := &memberServiceHarness{
		userRepo:    &testutil.MockUserRepo{},
		roleRepo:    &testutil.MockRoleRepo{},
		banRepo:     &testutil.MockBanRepo{},
		timeoutRepo: &testutil.MockMemberTimeoutRepo{},
		serverRepo:  &testutil.MockServerRepo{},
		hub:         &testutil.MockEventPublisher{},
		voiceKick:   &testutil.MockVoiceDisconnecter{},
	}
	h.hub.BroadcastToServerFn = func(_ string, e ws.Event) {
		h.broadcasts = append(h.broadcasts, e)
	}
	h.svc = NewMemberService(
		h.userRepo, h.roleRepo, h.banRepo, h.timeoutRepo,
		h.serverRepo, h.hub, h.voiceKick,
	)
	return h
}

// stubHierarchy makes actor's roles outrank target's so checkHierarchy
// passes. Mods with PermAdmin (bit) and no IsOwner role; target with a
// lower-position role and no IsOwner.
func (h *memberServiceHarness) stubHierarchy(actorID, targetID, serverID string) {
	h.roleRepo.GetByUserIDAndServerFn = func(_ context.Context, uid, _ string) ([]models.Role, error) {
		switch uid {
		case actorID:
			return []models.Role{{ID: "mod", Position: 10, Permissions: models.PermAll}}, nil
		case targetID:
			return []models.Role{{ID: "member", Position: 1}}, nil
		}
		return nil, nil
	}
}

// ─── Timeout ───

func TestTimeout_AppliesAndBroadcasts(t *testing.T) {
	h := newMemberHarness()
	const srv, actor, target = "srv1", "mod1", "victim1"
	h.stubHierarchy(actor, target, srv)

	var upserted *models.MemberTimeout
	h.timeoutRepo.UpsertFn = func(_ context.Context, mt *models.MemberTimeout) error {
		upserted = mt
		return nil
	}

	expiresAt := time.Now().UTC().Add(5 * time.Minute)
	err := h.svc.Timeout(context.Background(), srv, actor, target, expiresAt, "spam")
	if err != nil {
		t.Fatalf("Timeout returned error: %v", err)
	}

	if upserted == nil {
		t.Fatal("expected timeoutRepo.Upsert to be called")
	}
	if upserted.UserID != target || upserted.ServerID != srv {
		t.Errorf("upserted user/server mismatch: got user=%s server=%s", upserted.UserID, upserted.ServerID)
	}
	if upserted.AppliedBy != actor {
		t.Errorf("AppliedBy = %s, want %s", upserted.AppliedBy, actor)
	}
	if upserted.Reason != "spam" {
		t.Errorf("Reason = %q, want %q", upserted.Reason, "spam")
	}

	if len(h.broadcasts) != 1 || h.broadcasts[0].Op != ws.OpMemberTimeout {
		t.Fatalf("expected one %s broadcast, got %v", ws.OpMemberTimeout, h.broadcasts)
	}
	data, ok := h.broadcasts[0].Data.(map[string]any)
	if !ok {
		t.Fatalf("broadcast data is not map[string]any: %T", h.broadcasts[0].Data)
	}
	if data["user_id"] != target || data["server_id"] != srv {
		t.Errorf("broadcast payload user/server mismatch: %v", data)
	}
}

func TestTimeout_RefusesSelf(t *testing.T) {
	h := newMemberHarness()
	err := h.svc.Timeout(context.Background(), "srv1", "u1", "u1", time.Now().Add(time.Minute), "")
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected ErrBadRequest, got %v", err)
	}
	if len(h.broadcasts) != 0 {
		t.Errorf("self-timeout should not broadcast, got %v", h.broadcasts)
	}
}

func TestTimeout_RefusesEqualOrHigherRole(t *testing.T) {
	h := newMemberHarness()
	const srv, actor, target = "srv1", "mod1", "peer1"
	// Both roles at position 5 → checkHierarchy fails (actorMaxPos <= targetMaxPos).
	h.roleRepo.GetByUserIDAndServerFn = func(_ context.Context, _, _ string) ([]models.Role, error) {
		return []models.Role{{ID: "mod", Position: 5, Permissions: models.PermTimeoutMembers}}, nil
	}

	err := h.svc.Timeout(context.Background(), srv, actor, target, time.Now().Add(time.Minute), "")
	if !errors.Is(err, pkg.ErrForbidden) {
		t.Fatalf("expected ErrForbidden, got %v", err)
	}
}

func TestRemoveTimeout_DeletesAndBroadcasts(t *testing.T) {
	h := newMemberHarness()
	const srv, actor, target = "srv1", "mod1", "victim1"

	var deletedFor string
	h.timeoutRepo.DeleteFn = func(_ context.Context, _, userID string) error {
		deletedFor = userID
		return nil
	}

	err := h.svc.RemoveTimeout(context.Background(), srv, actor, target)
	if err != nil {
		t.Fatalf("RemoveTimeout returned error: %v", err)
	}
	if deletedFor != target {
		t.Errorf("Delete called with userID=%q, want %q", deletedFor, target)
	}

	if len(h.broadcasts) != 1 || h.broadcasts[0].Op != ws.OpMemberTimeoutRemove {
		t.Fatalf("expected one %s broadcast, got %v", ws.OpMemberTimeoutRemove, h.broadcasts)
	}
	data, ok := h.broadcasts[0].Data.(map[string]string)
	if !ok {
		t.Fatalf("broadcast data is not map[string]string: %T", h.broadcasts[0].Data)
	}
	if data["user_id"] != target {
		t.Errorf("broadcast user_id = %q, want %q", data["user_id"], target)
	}
}

// ─── GetByID populates TimeoutExpiresAt ───

func TestGetByID_IncludesTimeoutExpiresAt(t *testing.T) {
	h := newMemberHarness()
	const srv, uid = "srv1", "victim1"
	h.userRepo.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, Username: "victim", CreatedAt: time.Now()}, nil
	}
	h.roleRepo.GetByUserIDAndServerFn = func(_ context.Context, _, _ string) ([]models.Role, error) {
		return nil, nil
	}
	wantExpiry := time.Now().UTC().Add(3 * time.Minute)
	h.timeoutRepo.GetFn = func(_ context.Context, _, _ string) (*models.MemberTimeout, error) {
		return &models.MemberTimeout{
			ServerID: srv, UserID: uid, ExpiresAt: wantExpiry, AppliedBy: "mod1",
		}, nil
	}

	m, err := h.svc.GetByID(context.Background(), srv, uid)
	if err != nil {
		t.Fatalf("GetByID error: %v", err)
	}
	if m.TimeoutExpiresAt == nil {
		t.Fatal("expected TimeoutExpiresAt to be set")
	}
	if !m.TimeoutExpiresAt.Equal(wantExpiry) {
		t.Errorf("TimeoutExpiresAt = %v, want %v", m.TimeoutExpiresAt, wantExpiry)
	}
}

func TestGetByID_NoTimeoutLeavesFieldNil(t *testing.T) {
	h := newMemberHarness()
	h.userRepo.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, Username: "u"}, nil
	}
	h.timeoutRepo.GetFn = func(_ context.Context, _, _ string) (*models.MemberTimeout, error) {
		return nil, nil
	}

	m, err := h.svc.GetByID(context.Background(), "srv1", "u1")
	if err != nil {
		t.Fatalf("GetByID error: %v", err)
	}
	if m.TimeoutExpiresAt != nil {
		t.Errorf("expected nil TimeoutExpiresAt, got %v", m.TimeoutExpiresAt)
	}
}

// ─── GetAll bulk-loads timeouts ───

func TestGetAll_BulkLoadsTimeoutsViaListActive(t *testing.T) {
	h := newMemberHarness()
	const srv = "srv1"
	mutedExpiry := time.Now().UTC().Add(10 * time.Minute)

	h.userRepo.GetAllFn = func(_ context.Context) ([]models.User, error) {
		return []models.User{
			{ID: "a", Username: "a"},
			{ID: "b", Username: "b"},
		}, nil
	}
	h.serverRepo.IsMemberFn = func(_ context.Context, _, _ string) (bool, error) {
		return true, nil
	}
	h.roleRepo.GetByUserIDAndServerFn = func(_ context.Context, _, _ string) ([]models.Role, error) {
		return nil, nil
	}

	var listActiveCalls int
	h.timeoutRepo.ListActiveFn = func(_ context.Context, _ string) ([]models.MemberTimeout, error) {
		listActiveCalls++
		return []models.MemberTimeout{
			{ServerID: srv, UserID: "a", ExpiresAt: mutedExpiry},
		}, nil
	}
	// Failsafe: if anyone calls per-user Get during GetAll we'd know N+1
	// regressed. Set a counter so the test fails loudly.
	var perUserGetCalls int
	h.timeoutRepo.GetFn = func(_ context.Context, _, _ string) (*models.MemberTimeout, error) {
		perUserGetCalls++
		return nil, nil
	}

	members, err := h.svc.GetAll(context.Background(), srv)
	if err != nil {
		t.Fatalf("GetAll error: %v", err)
	}
	if listActiveCalls != 1 {
		t.Errorf("ListActive should be called exactly once, got %d", listActiveCalls)
	}
	if perUserGetCalls != 0 {
		t.Errorf("per-user Get should NOT be called during GetAll (N+1 regression), got %d", perUserGetCalls)
	}
	if len(members) != 2 {
		t.Fatalf("got %d members, want 2", len(members))
	}

	var muted, clean *models.MemberWithRoles
	for i := range members {
		if members[i].ID == "a" {
			muted = &members[i]
		} else if members[i].ID == "b" {
			clean = &members[i]
		}
	}
	if muted == nil || clean == nil {
		t.Fatalf("missing expected members; got %+v", members)
	}
	if muted.TimeoutExpiresAt == nil || !muted.TimeoutExpiresAt.Equal(mutedExpiry) {
		t.Errorf("muted member TimeoutExpiresAt = %v, want %v", muted.TimeoutExpiresAt, mutedExpiry)
	}
	if clean.TimeoutExpiresAt != nil {
		t.Errorf("unmuted member should have nil TimeoutExpiresAt, got %v", clean.TimeoutExpiresAt)
	}
}

// ─── Ban with expiresAt ───

func TestBan_WithExpiresAtPersistsAndEmitsAudit(t *testing.T) {
	h := newMemberHarness()
	const srv, actor, target = "srv1", "mod1", "victim1"
	h.stubHierarchy(actor, target, srv)
	h.userRepo.GetByIDFn = func(_ context.Context, _ string) (*models.User, error) {
		return &models.User{ID: target, Username: "victim"}, nil
	}

	var created *models.Ban
	h.banRepo.CreateFn = func(_ context.Context, b *models.Ban) error {
		created = b
		return nil
	}

	expiry := time.Now().UTC().Add(1 * time.Hour)
	if err := h.svc.Ban(context.Background(), srv, actor, target, "raid", &expiry); err != nil {
		t.Fatalf("Ban error: %v", err)
	}

	if created == nil {
		t.Fatal("Ban repo Create not called")
	}
	if created.ExpiresAt == nil || !created.ExpiresAt.Equal(expiry) {
		t.Errorf("created.ExpiresAt = %v, want %v", created.ExpiresAt, expiry)
	}
	if created.Reason != "raid" {
		t.Errorf("created.Reason = %q, want %q", created.Reason, "raid")
	}
	if created.BannedBy != actor {
		t.Errorf("created.BannedBy = %q, want %q", created.BannedBy, actor)
	}
}

func TestBan_PermanentLeavesExpiresAtNil(t *testing.T) {
	h := newMemberHarness()
	const srv, actor, target = "srv1", "mod1", "victim1"
	h.stubHierarchy(actor, target, srv)
	h.userRepo.GetByIDFn = func(_ context.Context, _ string) (*models.User, error) {
		return &models.User{ID: target, Username: "victim"}, nil
	}

	var created *models.Ban
	h.banRepo.CreateFn = func(_ context.Context, b *models.Ban) error {
		created = b
		return nil
	}

	if err := h.svc.Ban(context.Background(), srv, actor, target, "", nil); err != nil {
		t.Fatalf("Ban error: %v", err)
	}
	if created.ExpiresAt != nil {
		t.Errorf("permanent ban should have nil ExpiresAt, got %v", created.ExpiresAt)
	}
}

func TestUnban_DeletesRow(t *testing.T) {
	h := newMemberHarness()
	const srv, actor, target = "srv1", "mod1", "victim1"
	var deletedFor string
	h.banRepo.DeleteFn = func(_ context.Context, _, uid string) error {
		deletedFor = uid
		return nil
	}

	if err := h.svc.Unban(context.Background(), srv, actor, target); err != nil {
		t.Fatalf("Unban error: %v", err)
	}
	if deletedFor != target {
		t.Errorf("banRepo.Delete called for %q, want %q", deletedFor, target)
	}
}

// ─── UpdateProfile refreshes the hub userInfos cache ───

func TestUpdateProfile_RefreshesHubUserInfoCache(t *testing.T) {
	h := newMemberHarness()
	const uid = "u1"

	h.userRepo.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, Username: "alice"}, nil
	}
	h.userRepo.UpdateFn = func(_ context.Context, _ *models.User) error { return nil }
	h.serverRepo.GetUserServersFn = func(_ context.Context, _ string) ([]models.ServerListItem, error) {
		return nil, nil
	}

	var gotUserID, gotUsername, gotDisplay, gotAvatar string
	h.hub.UpdateUserInfoFn = func(userID, username, displayName, avatarURL string) {
		gotUserID, gotUsername, gotDisplay, gotAvatar = userID, username, displayName, avatarURL
	}

	display := "Alice Yeni"
	avatar := "/uploads/new.png"
	req := &models.UpdateProfileRequest{DisplayName: &display, AvatarURL: &avatar}
	if _, err := h.svc.UpdateProfile(context.Background(), uid, req); err != nil {
		t.Fatalf("UpdateProfile error: %v", err)
	}

	if gotUserID != uid || gotUsername != "alice" {
		t.Errorf("UpdateUserInfo called with user=%q username=%q, want %q/%q", gotUserID, gotUsername, uid, "alice")
	}
	if gotDisplay != display || gotAvatar != avatar {
		t.Errorf("UpdateUserInfo display/avatar = %q/%q, want %q/%q", gotDisplay, gotAvatar, display, avatar)
	}
}

func TestUpdateProfile_NoCacheRefreshWhenUpdateFails(t *testing.T) {
	h := newMemberHarness()
	h.userRepo.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, Username: "alice"}, nil
	}
	h.userRepo.UpdateFn = func(_ context.Context, _ *models.User) error {
		return errors.New("db down")
	}
	called := false
	h.hub.UpdateUserInfoFn = func(_, _, _, _ string) { called = true }

	display := "X"
	if _, err := h.svc.UpdateProfile(context.Background(), "u1", &models.UpdateProfileRequest{DisplayName: &display}); err == nil {
		t.Fatal("expected error from UpdateProfile")
	}
	if called {
		t.Error("UpdateUserInfo must not be called when the DB update fails")
	}
}
