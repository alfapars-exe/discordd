package services

import "testing"

// stubInvalidator is a minimal PermissionInvalidator that records calls, so
// tests can assert fan-out without depending on channelPermService or
// middleware.PermissionMiddleware internals.
type stubInvalidator struct {
	userCalls []string
	allCount  int
}

func (s *stubInvalidator) InvalidateUser(userID string) {
	s.userCalls = append(s.userCalls, userID)
}

func (s *stubInvalidator) InvalidateAll() {
	s.allCount++
}

func TestMultiInvalidator_InvalidateUser_FansOutToEveryTarget(t *testing.T) {
	a := &stubInvalidator{}
	b := &stubInvalidator{}
	mi := NewMultiInvalidator(a, b)

	mi.InvalidateUser("user-1")

	if len(a.userCalls) != 1 || a.userCalls[0] != "user-1" {
		t.Errorf("target a InvalidateUser calls = %v, want [user-1]", a.userCalls)
	}
	if len(b.userCalls) != 1 || b.userCalls[0] != "user-1" {
		t.Errorf("target b InvalidateUser calls = %v, want [user-1]", b.userCalls)
	}
}

func TestMultiInvalidator_InvalidateAll_FansOutToEveryTarget(t *testing.T) {
	a := &stubInvalidator{}
	b := &stubInvalidator{}
	mi := NewMultiInvalidator(a, b)

	mi.InvalidateAll()

	if a.allCount != 1 {
		t.Errorf("target a InvalidateAll count = %d, want 1", a.allCount)
	}
	if b.allCount != 1 {
		t.Errorf("target b InvalidateAll count = %d, want 1", b.allCount)
	}
}

func TestMultiInvalidator_NoTargets_DoesNotPanic(t *testing.T) {
	mi := NewMultiInvalidator()
	mi.InvalidateUser("user-1")
	mi.InvalidateAll()
}
