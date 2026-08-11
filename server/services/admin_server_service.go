// Package services — AdminServerService: platform admin server management.
//
// Allows platform admin to delete any server (unlike owner-only ServerService.DeleteServer).
//
// Deletion order:
// 1. LiveKit instance cleanup (platform -> decrement, self-hosted -> delete)
// 2. server_delete broadcast (BEFORE DB delete — member list is needed for broadcast)
// 3. Pre-fetch attachment file_urls (best-effort; a fetch failure just means
//    step 5 below has nothing to clean up, it never blocks the delete)
// 4. Transactional cascade delete: channels, categories, roles, invites,
//    user_roles, bans, and everything under channels/roles have no enforced
//    foreign key to servers (see repository.deleteServerCascade) and are
//    deleted explicitly here, then the servers row itself.
// 5. Best-effort on-disk cleanup of the attachment files fetched in step 3
//    (see services/upload_cleanup.go) — only after step 4 commits.
// 6. Optional email notification to server owner
package services

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

var adminServerLogger = logx.Component("service.admin_server")

// AdminServerService handles platform admin server deletion.
type AdminServerService interface {
	DeleteServer(ctx context.Context, adminUserID, serverID, reason string) error
	SetUploadDir(dir string)
}

type adminServerService struct {
	db          *sql.DB // for WithTx around the cascade delete, mirrors ServerService
	serverRepo  repository.ServerRepository
	userRepo    repository.UserRepository
	livekitRepo repository.LiveKitRepository
	hub         ws.EventPublisher
	emailSender email.EmailSender // optional, nil = no emails
	// uploadDir enables best-effort disk cleanup on server delete (see
	// upload_cleanup.go). Blank disables cleanup — set via SetUploadDir,
	// wired in init_services.go so the constructor signature below stays
	// unchanged.
	uploadDir string
}

func (s *adminServerService) SetUploadDir(dir string) {
	s.uploadDir = dir
}

func NewAdminServerService(
	db *sql.DB,
	serverRepo repository.ServerRepository,
	userRepo repository.UserRepository,
	livekitRepo repository.LiveKitRepository,
	hub ws.EventPublisher,
	emailSender email.EmailSender,
) AdminServerService {
	return &adminServerService{
		db:          db,
		serverRepo:  serverRepo,
		userRepo:    userRepo,
		livekitRepo: livekitRepo,
		hub:         hub,
		emailSender: emailSender,
	}
}

func (s *adminServerService) DeleteServer(ctx context.Context, adminUserID, serverID, reason string) error {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return fmt.Errorf("server not found: %w", err)
	}

	// LiveKit instance cleanup
	if server.LiveKitInstanceID != nil {
		instance, lkErr := s.livekitRepo.GetByID(ctx, *server.LiveKitInstanceID)
		if lkErr == nil {
			if instance.IsPlatformManaged {
				if decErr := s.livekitRepo.DecrementServerCount(ctx, instance.ID); decErr != nil {
					adminServerLogger.Error("failed to decrement livekit server count", "instance_id", instance.ID, "err", pkg.ErrText(decErr))
				}
			} else {
				if delErr := s.livekitRepo.Delete(ctx, instance.ID); delErr != nil {
					adminServerLogger.Error("failed to delete self-hosted livekit instance", "instance_id", instance.ID, "err", pkg.ErrText(delErr))
				}
			}
		}
	}

	// Broadcast BEFORE delete (member list is lost after)
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpServerDelete,
		Data: map[string]string{"id": serverID},
	})

	// Pre-fetch attachment file_urls for the post-delete disk cleanup below.
	// A fetch failure here is logged and non-fatal — the delete still
	// proceeds, it just can't clean up files it couldn't enumerate.
	fileURLs, urlErr := s.serverRepo.GetFileURLsByServerID(ctx, serverID)
	if urlErr != nil {
		adminServerLogger.Error("failed to fetch file urls before server delete", "server_id", serverID, "err", pkg.ErrText(urlErr))
	}

	// Transactional so the cascade and the server row either all go or none
	// do — see the package comment above and repository.deleteServerCascade.
	if err := database.WithTx(ctx, s.db, func(tx *sql.Tx) error {
		return repository.NewSQLiteServerRepo(tx).Delete(ctx, serverID)
	}); err != nil {
		return fmt.Errorf("failed to delete server: %w", err)
	}

	// Only remove files once the DB delete has actually committed — see
	// upload_cleanup.go for why the ordering matters.
	removeUploadFilesByURL(s.uploadDir, fileURLs)

	// Best-effort email to server owner
	if reason != "" && s.emailSender != nil {
		owner, ownerErr := s.userRepo.GetByID(ctx, server.OwnerID)
		if ownerErr == nil && owner.Email != nil {
			if emailErr := s.emailSender.SendServerDeleteNotification(ctx, *owner.Email, server.Name, reason); emailErr != nil {
				adminServerLogger.Error("failed to send server delete notification", "owner_id", server.OwnerID, "err", pkg.ErrText(emailErr))
			}
		}
	}

	adminServerLogger.Info("admin deleted server", "admin_id", adminUserID, "server_id", serverID, "server_name", server.Name)
	return nil
}
