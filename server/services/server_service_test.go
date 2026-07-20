// Server service tests — cover JoinServer, the invite-driven join path.
//
// Pattern follows member_service_test.go: a harness wires hand-rolled mocks
// from testutil, then each test case overrides only the Fn fields it cares
// about. Focus here is the B3 regression: MarkUsed (the invite use-counter
// bump) must fire only once membership actually lands — a failed join must
// not burn a max_uses slot.
package services

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

const (
	joinTestServerID = "srv-join-1"
	joinTestUserID   = "user-join-1"
	joinTestCode     = "invite-code-1"
)

// joinServerHarness bundles the mocks JoinServer touches. livekitRepo/
// channelRepo/categoryRepo/db/encryptionKey are untouched by JoinServer —
// nil is safe and avoids wiring mocks for unrelated interfaces.
type joinServerHarness struct {
	svc        ServerService
	serverRepo *testutil.MockServerRepo
	roleRepo   *testutil.MockRoleRepo
	userRepo   *testutil.MockUserRepo
	inviteSvc  *testutil.MockInviteService
	hub        *testutil.MockEventPublisher
}

// newJoinServerHarness wires sensible happy-path defaults for every mock
// JoinServer touches after AddMember succeeds, so table-test cases only need
// to override the field(s) that make that case interesting.
func newJoinServerHarness() *joinServerHarness {
	h := &joinServerHarness{
		serverRepo: &testutil.MockServerRepo{},
		roleRepo:   &testutil.MockRoleRepo{},
		userRepo:   &testutil.MockUserRepo{},
		inviteSvc:  &testutil.MockInviteService{},
		hub:        &testutil.MockEventPublisher{},
	}

	h.inviteSvc.ValidateFn = func(_ context.Context, code string) (*models.Invite, error) {
		return &models.Invite{Code: code, ServerID: joinTestServerID}, nil
	}
	h.serverRepo.IsMemberFn = func(_ context.Context, _, _ string) (bool, error) {
		return false, nil
	}
	h.serverRepo.GetByIDFn = func(_ context.Context, serverID string) (*models.Server, error) {
		return &models.Server{ID: serverID, Name: "Test Server"}, nil
	}
	h.roleRepo.GetDefaultByServerFn = func(_ context.Context, _ string) (*models.Role, error) {
		return &models.Role{ID: "role-default"}, nil
	}
	h.userRepo.GetByIDFn = func(_ context.Context, id string) (*models.User, error) {
		return &models.User{ID: id, Username: "joiner"}, nil
	}

	h.svc = NewServerService(nil, h.serverRepo, nil, h.roleRepo, nil, nil, h.userRepo, h.inviteSvc, h.hub, nil)
	return h
}

func TestJoinServer_ValidInvite_AddsMemberAndMarksUsed(t *testing.T) {
	h := newJoinServerHarness()

	var addMemberCalled, markUsedCalled, assignRoleCalled bool
	h.serverRepo.AddMemberFn = func(_ context.Context, serverID, userID string) error {
		addMemberCalled = true
		if serverID != joinTestServerID || userID != joinTestUserID {
			t.Errorf("AddMember called with serverID=%s userID=%s", serverID, userID)
		}
		return nil
	}
	h.inviteSvc.MarkUsedFn = func(_ context.Context, code string) error {
		markUsedCalled = true
		if code != joinTestCode {
			t.Errorf("MarkUsed called with code=%s, want %s", code, joinTestCode)
		}
		return nil
	}
	h.roleRepo.AssignToUserFn = func(_ context.Context, userID, roleID, serverID string) error {
		assignRoleCalled = true
		if userID != joinTestUserID || roleID != "role-default" || serverID != joinTestServerID {
			t.Errorf("AssignToUser called with unexpected args: user=%s role=%s server=%s", userID, roleID, serverID)
		}
		return nil
	}

	server, err := h.svc.JoinServer(context.Background(), joinTestUserID, joinTestCode)
	if err != nil {
		t.Fatalf("JoinServer returned error: %v", err)
	}
	if server == nil || server.ID != joinTestServerID {
		t.Fatalf("expected returned server ID=%s, got %+v", joinTestServerID, server)
	}
	if !addMemberCalled {
		t.Error("expected AddMember to be called")
	}
	if !markUsedCalled {
		t.Error("expected MarkUsed to be called after a successful join")
	}
	if !assignRoleCalled {
		t.Error("expected default role to be assigned")
	}
}

func TestJoinServer_ExpiredInvite(t *testing.T) {
	h := newJoinServerHarness()
	h.inviteSvc.ValidateFn = func(_ context.Context, _ string) (*models.Invite, error) {
		return nil, fmt.Errorf("%w: invite code has expired", pkg.ErrBadRequest)
	}

	var addMemberCalled, markUsedCalled bool
	h.serverRepo.AddMemberFn = func(_ context.Context, _, _ string) error {
		addMemberCalled = true
		return nil
	}
	h.inviteSvc.MarkUsedFn = func(_ context.Context, _ string) error {
		markUsedCalled = true
		return nil
	}

	_, err := h.svc.JoinServer(context.Background(), joinTestUserID, joinTestCode)
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected pkg.ErrBadRequest, got %v", err)
	}
	if addMemberCalled {
		t.Error("AddMember must not be called for an expired invite")
	}
	if markUsedCalled {
		t.Error("MarkUsed must not be called for an expired invite")
	}
}

func TestJoinServer_MaxUsesExceeded(t *testing.T) {
	h := newJoinServerHarness()
	h.inviteSvc.ValidateFn = func(_ context.Context, _ string) (*models.Invite, error) {
		return nil, fmt.Errorf("%w: invite code has reached max uses", pkg.ErrBadRequest)
	}

	var addMemberCalled, markUsedCalled bool
	h.serverRepo.AddMemberFn = func(_ context.Context, _, _ string) error {
		addMemberCalled = true
		return nil
	}
	h.inviteSvc.MarkUsedFn = func(_ context.Context, _ string) error {
		markUsedCalled = true
		return nil
	}

	_, err := h.svc.JoinServer(context.Background(), joinTestUserID, joinTestCode)
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected pkg.ErrBadRequest, got %v", err)
	}
	if addMemberCalled {
		t.Error("AddMember must not be called when max_uses is exceeded")
	}
	if markUsedCalled {
		t.Error("MarkUsed must not be called when max_uses is exceeded")
	}
}

// TestJoinServer_AlreadyMember is the core B3 regression pin: a join that
// fails because the user is already a member must not burn the invite's
// use slot.
func TestJoinServer_AlreadyMember(t *testing.T) {
	h := newJoinServerHarness()
	h.serverRepo.IsMemberFn = func(_ context.Context, _, _ string) (bool, error) {
		return true, nil
	}

	var addMemberCalled, markUsedCalled bool
	h.serverRepo.AddMemberFn = func(_ context.Context, _, _ string) error {
		addMemberCalled = true
		return nil
	}
	h.inviteSvc.MarkUsedFn = func(_ context.Context, _ string) error {
		markUsedCalled = true
		return nil
	}

	_, err := h.svc.JoinServer(context.Background(), joinTestUserID, joinTestCode)
	if !errors.Is(err, pkg.ErrBadRequest) {
		t.Fatalf("expected pkg.ErrBadRequest, got %v", err)
	}
	if addMemberCalled {
		t.Error("AddMember must not be called when the user is already a member")
	}
	if markUsedCalled {
		t.Error("MarkUsed must not be called when the user is already a member (B3 regression)")
	}
}

// TestJoinServer_AddMemberFails covers the second B3 pin: a join that fails
// inside AddMember itself (not just the already-member precheck) must also
// leave the invite's use slot untouched.
func TestJoinServer_AddMemberFails(t *testing.T) {
	h := newJoinServerHarness()
	h.serverRepo.AddMemberFn = func(_ context.Context, _, _ string) error {
		return errors.New("db error: add member failed")
	}

	var markUsedCalled bool
	h.inviteSvc.MarkUsedFn = func(_ context.Context, _ string) error {
		markUsedCalled = true
		return nil
	}

	_, err := h.svc.JoinServer(context.Background(), joinTestUserID, joinTestCode)
	if err == nil {
		t.Fatal("expected error when AddMember fails")
	}
	if markUsedCalled {
		t.Error("MarkUsed must not be called when AddMember fails (B3 regression)")
	}
}
