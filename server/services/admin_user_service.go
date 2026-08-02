// Package services — AdminUserService: platform-level user management.
//
// Handles platform-wide ban and hard delete (distinct from server-scoped MemberService.BanUser).
// Email notifications are optional — sent if reason is provided and user has an email.
// Email errors do not roll back the action.
package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

var adminUserLogger = logx.Component("service.admin_user")

// UserCacheInvalidator drops a cached authenticated-user row so a ban /
// delete / admin-status change takes effect on the next HTTP request
// instead of waiting out AuthMiddleware's user-cache TTL (~30s). Satisfied
// by *middleware.AuthMiddleware; defined here (ISP) to avoid a
// services -> middleware import cycle.
type UserCacheInvalidator interface {
	InvalidateUser(userID string)
}

// AdminUserService handles platform-level user ban and deletion.
type AdminUserService interface {
	PlatformBanUser(ctx context.Context, adminUserID, targetUserID, reason string, deleteMessages bool) error
	PlatformUnbanUser(ctx context.Context, adminUserID, targetUserID string) error
	HardDeleteUser(ctx context.Context, adminUserID, targetUserID, reason string) error
	SetPlatformAdmin(ctx context.Context, adminUserID, targetUserID string, isAdmin bool) error
	SetUserCacheInvalidator(inv UserCacheInvalidator)
}

type adminUserService struct {
	userRepo    repository.UserRepository
	hub         ws.ClientManager
	voiceKit    VoiceDisconnecter // ISP defined in member_service.go
	emailSender email.EmailSender // optional, nil = no emails
	// userInvalidator drops the HTTP auth user-cache on ban/delete/admin
	// change. Optional (nil-safe): absent wiring, the change still lands
	// within the cache TTL — this just makes it immediate.
	userInvalidator UserCacheInvalidator
}

func NewAdminUserService(
	userRepo repository.UserRepository,
	hub ws.ClientManager,
	voiceKit VoiceDisconnecter,
	emailSender email.EmailSender,
) AdminUserService {
	return &adminUserService{
		userRepo:    userRepo,
		hub:         hub,
		voiceKit:    voiceKit,
		emailSender: emailSender,
	}
}

// SetUserCacheInvalidator wires the auth middleware's user-cache invalidator.
// Called post-construction in main.go because the middleware is built after
// the service layer (it depends on the auth service).
func (s *adminUserService) SetUserCacheInvalidator(inv UserCacheInvalidator) {
	s.userInvalidator = inv
}

// invalidateUserCache is nil-safe — a no-op when the invalidator isn't wired.
func (s *adminUserService) invalidateUserCache(userID string) {
	if s.userInvalidator != nil {
		s.userInvalidator.InvalidateUser(userID)
	}
}

func (s *adminUserService) PlatformBanUser(ctx context.Context, adminUserID, targetUserID, reason string, deleteMessages bool) error {
	if adminUserID == targetUserID {
		return fmt.Errorf("%w: cannot ban yourself", pkg.ErrBadRequest)
	}

	target, err := s.userRepo.GetByID(ctx, targetUserID)
	if err != nil {
		return fmt.Errorf("target user not found: %w", err)
	}

	if target.IsPlatformAdmin {
		return fmt.Errorf("%w: cannot ban a platform admin", pkg.ErrForbidden)
	}

	if target.IsPlatformBanned {
		return fmt.Errorf("%w: user is already banned", pkg.ErrBadRequest)
	}

	if err := s.userRepo.PlatformBan(ctx, targetUserID, reason, adminUserID); err != nil {
		return fmt.Errorf("failed to ban user: %w", err)
	}

	if deleteMessages {
		if err := s.userRepo.DeleteAllMessagesByUser(ctx, targetUserID); err != nil {
			return fmt.Errorf("failed to delete user messages: %w", err)
		}
	}

	s.voiceKit.DisconnectUser(targetUserID)
	s.hub.DisconnectUser(targetUserID)
	// Drop the HTTP auth cache so the ban is enforced on the next REST call
	// rather than up to ~30s later. The WS path is already cut above.
	s.invalidateUserCache(targetUserID)

	// Best-effort email notification
	if reason != "" && target.Email != nil && s.emailSender != nil {
		if emailErr := s.emailSender.SendPlatformBanNotification(ctx, *target.Email, reason); emailErr != nil {
			adminUserLogger.Error("failed to send ban notification email", "target_id", targetUserID, "err", pkg.ErrText(emailErr))
		}
	}

	return nil
}

func (s *adminUserService) PlatformUnbanUser(ctx context.Context, adminUserID, targetUserID string) error {
	if adminUserID == targetUserID {
		return fmt.Errorf("%w: cannot unban yourself", pkg.ErrBadRequest)
	}

	target, err := s.userRepo.GetByID(ctx, targetUserID)
	if err != nil {
		return fmt.Errorf("target user not found: %w", err)
	}

	if !target.IsPlatformBanned {
		return fmt.Errorf("%w: user is not banned", pkg.ErrBadRequest)
	}

	if err := s.userRepo.PlatformUnban(ctx, targetUserID); err != nil {
		return fmt.Errorf("failed to unban user: %w", err)
	}
	// Clear the cached banned row so the user can authenticate immediately.
	s.invalidateUserCache(targetUserID)

	return nil
}

// HardDeleteUser permanently deletes a user and all associated data.
// Email notification is sent BEFORE deletion (email address is lost after delete).
//
// Deliberately NOT wired into the upload_cleanup.go best-effort disk cleanup
// that message/DM-message/channel/server/feedback-ticket delete got: this
// path is admin-only and rare, and "all associated data" here spans every
// table with a user_id FK (messages, attachments across four tables,
// avatars, etc.) via whatever CASCADE/explicit-delete shape
// userRepo.HardDeleteUser implements — collecting every file_url that
// implies is a distinct, larger piece of work than the per-resource delete
// paths above and was scoped out rather than done partially.
func (s *adminUserService) HardDeleteUser(ctx context.Context, adminUserID, targetUserID, reason string) error {
	if adminUserID == targetUserID {
		return fmt.Errorf("%w: cannot delete yourself", pkg.ErrBadRequest)
	}

	target, err := s.userRepo.GetByID(ctx, targetUserID)
	if err != nil {
		return fmt.Errorf("target user not found: %w", err)
	}

	if target.IsPlatformAdmin {
		return fmt.Errorf("%w: cannot delete a platform admin", pkg.ErrForbidden)
	}

	// Send email BEFORE deletion (address is lost after)
	if reason != "" && target.Email != nil && s.emailSender != nil {
		if emailErr := s.emailSender.SendAccountDeleteNotification(ctx, *target.Email, reason); emailErr != nil {
			adminUserLogger.Error("failed to send delete notification email", "target_id", targetUserID, "err", pkg.ErrText(emailErr))
		}
	}

	// Disconnect realtime connections before DB delete to avoid race conditions
	s.voiceKit.DisconnectUser(targetUserID)
	s.hub.DisconnectUser(targetUserID)

	if err := s.userRepo.HardDeleteUser(ctx, targetUserID); err != nil {
		return fmt.Errorf("failed to delete user: %w", err)
	}
	// Cached row now points at a deleted user — drop it so the next request
	// re-reads (and 401s) instead of serving the stale identity for the TTL.
	s.invalidateUserCache(targetUserID)

	return nil
}

func (s *adminUserService) SetPlatformAdmin(ctx context.Context, adminUserID, targetUserID string, isAdmin bool) error {
	if adminUserID == targetUserID {
		return fmt.Errorf("%w: cannot modify your own admin status", pkg.ErrBadRequest)
	}

	if _, err := s.userRepo.GetByID(ctx, targetUserID); err != nil {
		return fmt.Errorf("target user not found: %w", err)
	}

	if err := s.userRepo.SetPlatformAdmin(ctx, targetUserID, isAdmin); err != nil {
		return fmt.Errorf("failed to update admin status: %w", err)
	}
	// Refresh the cached row so the new admin flag takes effect on the next
	// request (grant or revoke) instead of after the cache TTL.
	s.invalidateUserCache(targetUserID)

	return nil
}
