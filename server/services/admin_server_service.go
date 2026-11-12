// Package services — AdminServerService: platform admin server management.
//
// Allows platform admin to delete any server (unlike owner-only ServerService.DeleteServer).
//
// The database transaction releases the assigned LiveKit instance after deleting the server.
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
	hub ws.EventPublisher,
	emailSender email.EmailSender,
) AdminServerService {
	return &adminServerService{
		db:          db,
		serverRepo:  serverRepo,
		userRepo:    userRepo,
		hub:         hub,
		emailSender: emailSender,
	}
}

func (s *adminServerService) DeleteServer(ctx context.Context, adminUserID, serverID, reason string) error {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return fmt.Errorf("server not found: %w", err)
	}

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
		return repository.NewSQLiteServerRepoWithDialect(tx, database.IsPostgres(s.db)).Delete(ctx, serverID)
	}); err != nil {
		return fmt.Errorf("failed to delete server: %w", err)
	}
	// The hub tracks connected server members independently of the database rows.
	s.hub.BroadcastToServer(serverID, ws.Event{
		Op:   ws.OpServerDelete,
		Data: map[string]string{"id": serverID},
	})


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
