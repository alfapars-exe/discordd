package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

// ── test-local stubs for the small ISP interfaces this service depends on ──

type adminHubStub struct{ disconnected []string }

func (s *adminHubStub) SetInvisible(string, bool)                     {}
func (s *adminHubStub) DisconnectUser(userID string)                  { s.disconnected = append(s.disconnected, userID) }
func (s *adminHubStub) AddClientServerID(string, string)              {}
func (s *adminHubStub) RemoveClientServerID(string, string)           {}
func (s *adminHubStub) UpdateUserInfo(string, string, string, string) {}

type adminVoiceStub struct{ disconnected []string }

func (s *adminVoiceStub) DisconnectUser(userID string) {
	s.disconnected = append(s.disconnected, userID)
}

type adminInvalStub struct{ invalidated []string }

func (s *adminInvalStub) InvalidateUser(userID string) { s.invalidated = append(s.invalidated, userID) }

type adminHarness struct {
	svc   AdminUserService
	hub   *adminHubStub
	voice *adminVoiceStub
	inval *adminInvalStub
}

func newAdminHarness(userRepo *testutil.MockUserRepo, email *testutil.MockEmailSender) adminHarness {
	hub := &adminHubStub{}
	voice := &adminVoiceStub{}
	inval := &adminInvalStub{}
	svc := NewAdminUserService(userRepo, hub, voice, email)
	svc.SetUserCacheInvalidator(inval)
	return adminHarness{svc: svc, hub: hub, voice: voice, inval: inval}
}

// userReturning builds a MockUserRepo whose GetByID yields the given user.
func userReturning(u *models.User) *testutil.MockUserRepo {
	return &testutil.MockUserRepo{GetByIDFn: func(context.Context, string) (*models.User, error) { return u, nil }}
}

func TestPlatformBanUser(t *testing.T) {
	ctx := context.Background()

	t.Run("cannot ban yourself", func(t *testing.T) {
		h := newAdminHarness(&testutil.MockUserRepo{}, &testutil.MockEmailSender{})
		if err := h.svc.PlatformBanUser(ctx, "same", "same", "spam", false); !errors.Is(err, pkg.ErrBadRequest) {
			t.Errorf("err = %v, want ErrBadRequest", err)
		}
	})

	t.Run("cannot ban a platform admin", func(t *testing.T) {
		ur := userReturning(&models.User{ID: "t", IsPlatformAdmin: true})
		h := newAdminHarness(ur, &testutil.MockEmailSender{})
		if err := h.svc.PlatformBanUser(ctx, "admin", "t", "", false); !errors.Is(err, pkg.ErrForbidden) {
			t.Errorf("err = %v, want ErrForbidden", err)
		}
	})

	t.Run("already-banned user is rejected", func(t *testing.T) {
		ur := userReturning(&models.User{ID: "t", IsPlatformBanned: true})
		h := newAdminHarness(ur, &testutil.MockEmailSender{})
		if err := h.svc.PlatformBanUser(ctx, "admin", "t", "", false); !errors.Is(err, pkg.ErrBadRequest) {
			t.Errorf("err = %v, want ErrBadRequest", err)
		}
	})

	t.Run("successful ban cuts realtime access and invalidates the cache", func(t *testing.T) {
		banned := false
		email := "victim@example.com"
		ur := userReturning(&models.User{ID: "t", Email: &email})
		ur.PlatformBanFn = func(context.Context, string, string, string) error { banned = true; return nil }
		var sentReason string
		mail := &testutil.MockEmailSender{SendPlatformBanNotificationFn: func(_ context.Context, _, reason string) error {
			sentReason = reason
			return nil
		}}
		h := newAdminHarness(ur, mail)

		if err := h.svc.PlatformBanUser(ctx, "admin", "t", "abuse", false); err != nil {
			t.Fatalf("PlatformBanUser: %v", err)
		}
		if !banned {
			t.Error("PlatformBan must be called")
		}
		if len(h.hub.disconnected) != 1 || h.hub.disconnected[0] != "t" {
			t.Errorf("hub.DisconnectUser = %v, want [t]", h.hub.disconnected)
		}
		if len(h.voice.disconnected) != 1 || h.voice.disconnected[0] != "t" {
			t.Errorf("voice.DisconnectUser = %v, want [t]", h.voice.disconnected)
		}
		if len(h.inval.invalidated) != 1 || h.inval.invalidated[0] != "t" {
			t.Errorf("invalidateUserCache = %v, want [t]", h.inval.invalidated)
		}
		if sentReason != "abuse" {
			t.Errorf("ban email reason = %q, want abuse", sentReason)
		}
	})

	t.Run("deleteMessages triggers message purge", func(t *testing.T) {
		purged := false
		ur := userReturning(&models.User{ID: "t"})
		ur.DeleteAllMessagesByUserFn = func(context.Context, string) error { purged = true; return nil }
		h := newAdminHarness(ur, &testutil.MockEmailSender{})
		if err := h.svc.PlatformBanUser(ctx, "admin", "t", "", true); err != nil {
			t.Fatalf("PlatformBanUser: %v", err)
		}
		if !purged {
			t.Error("deleteMessages=true must purge the user's messages")
		}
	})
}

func TestPlatformUnbanUser(t *testing.T) {
	ctx := context.Background()

	t.Run("unbanning a non-banned user is rejected", func(t *testing.T) {
		ur := userReturning(&models.User{ID: "t", IsPlatformBanned: false})
		h := newAdminHarness(ur, &testutil.MockEmailSender{})
		if err := h.svc.PlatformUnbanUser(ctx, "admin", "t"); !errors.Is(err, pkg.ErrBadRequest) {
			t.Errorf("err = %v, want ErrBadRequest", err)
		}
	})

	t.Run("successful unban invalidates the cache", func(t *testing.T) {
		unbanned := false
		ur := userReturning(&models.User{ID: "t", IsPlatformBanned: true})
		ur.PlatformUnbanFn = func(context.Context, string) error { unbanned = true; return nil }
		h := newAdminHarness(ur, &testutil.MockEmailSender{})
		if err := h.svc.PlatformUnbanUser(ctx, "admin", "t"); err != nil {
			t.Fatalf("PlatformUnbanUser: %v", err)
		}
		if !unbanned {
			t.Error("PlatformUnban must be called")
		}
		if len(h.inval.invalidated) != 1 {
			t.Errorf("invalidateUserCache count = %d, want 1", len(h.inval.invalidated))
		}
	})
}

func TestHardDeleteUser(t *testing.T) {
	ctx := context.Background()

	t.Run("cannot delete yourself", func(t *testing.T) {
		h := newAdminHarness(&testutil.MockUserRepo{}, &testutil.MockEmailSender{})
		if err := h.svc.HardDeleteUser(ctx, "same", "same", ""); !errors.Is(err, pkg.ErrBadRequest) {
			t.Errorf("err = %v, want ErrBadRequest", err)
		}
	})

	t.Run("cannot delete a platform admin", func(t *testing.T) {
		ur := userReturning(&models.User{ID: "t", IsPlatformAdmin: true})
		h := newAdminHarness(ur, &testutil.MockEmailSender{})
		if err := h.svc.HardDeleteUser(ctx, "admin", "t", ""); !errors.Is(err, pkg.ErrForbidden) {
			t.Errorf("err = %v, want ErrForbidden", err)
		}
	})

	t.Run("email is sent before deletion, then realtime is cut and cache dropped", func(t *testing.T) {
		email := "gone@example.com"
		ur := userReturning(&models.User{ID: "t", Email: &email})
		deleted := false
		ur.HardDeleteUserFn = func(context.Context, string) error { deleted = true; return nil }
		emailSentBeforeDelete := false
		mail := &testutil.MockEmailSender{SendAccountDeleteNotificationFn: func(context.Context, string, string) error {
			emailSentBeforeDelete = !deleted // delete must not have happened yet
			return nil
		}}
		h := newAdminHarness(ur, mail)

		if err := h.svc.HardDeleteUser(ctx, "admin", "t", "cleanup"); err != nil {
			t.Fatalf("HardDeleteUser: %v", err)
		}
		if !emailSentBeforeDelete {
			t.Error("the delete-notification email must be sent BEFORE the row is deleted")
		}
		if !deleted {
			t.Error("HardDeleteUser must be called")
		}
		if len(h.hub.disconnected) != 1 || len(h.voice.disconnected) != 1 || len(h.inval.invalidated) != 1 {
			t.Errorf("expected one disconnect+invalidate each, got hub=%v voice=%v inval=%v",
				h.hub.disconnected, h.voice.disconnected, h.inval.invalidated)
		}
	})
}

func TestSetPlatformAdmin(t *testing.T) {
	ctx := context.Background()

	t.Run("cannot modify your own admin status", func(t *testing.T) {
		h := newAdminHarness(&testutil.MockUserRepo{}, &testutil.MockEmailSender{})
		if err := h.svc.SetPlatformAdmin(ctx, "same", "same", true); !errors.Is(err, pkg.ErrBadRequest) {
			t.Errorf("err = %v, want ErrBadRequest", err)
		}
	})

	t.Run("grant persists and invalidates the cache", func(t *testing.T) {
		var setTo bool
		var called bool
		ur := userReturning(&models.User{ID: "t"})
		ur.SetPlatformAdminFn = func(_ context.Context, _ string, isAdmin bool) error {
			called, setTo = true, isAdmin
			return nil
		}
		h := newAdminHarness(ur, &testutil.MockEmailSender{})
		if err := h.svc.SetPlatformAdmin(ctx, "admin", "t", true); err != nil {
			t.Fatalf("SetPlatformAdmin: %v", err)
		}
		if !called || setTo != true {
			t.Errorf("SetPlatformAdmin called=%v value=%v, want called=true value=true", called, setTo)
		}
		if len(h.inval.invalidated) != 1 {
			t.Errorf("invalidateUserCache count = %d, want 1", len(h.inval.invalidated))
		}
	})
}
