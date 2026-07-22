package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

var e2eeLogger = logx.Component("service.e2ee")

// E2EEService handles key backup and group session management.
//
// Key Backup: encrypted key backup/restore via recovery password.
// The server stores opaque blobs only — it never sees the recovery password.
//
// Group Session: server-side coordination of Sender Key group sessions.
// Session data is opaque to the server — stored and distributed only.
type E2EEService interface {
	UpsertKeyBackup(ctx context.Context, userID string, req *models.CreateKeyBackupRequest) error
	GetKeyBackup(ctx context.Context, userID string) (*models.E2EEKeyBackup, error)
	DeleteKeyBackup(ctx context.Context, userID string) error

	// UpsertGroupSession creates/updates a Sender Key group session.
	// Broadcasts "group_session_new" to channel members on success.
	UpsertGroupSession(ctx context.Context, serverID, channelID, userID, deviceID string, req *models.CreateGroupSessionRequest) error
	GetGroupSessions(ctx context.Context, serverID, channelID, userID string) ([]models.ChannelGroupSession, error)
	DeleteGroupSessionsByChannel(ctx context.Context, channelID string) error
	DeleteGroupSessionsByUser(ctx context.Context, channelID, userID string) error
}

type e2eeService struct {
	backupRepo       repository.E2EEKeyBackupRepository
	groupSessionRepo repository.GroupSessionRepository
	hub              ws.Broadcaster
	channelGetter    ChannelGetter
	permResolver     ChannelPermResolver
	backupHMACKey    []byte
}

func NewE2EEService(
	backupRepo repository.E2EEKeyBackupRepository,
	groupSessionRepo repository.GroupSessionRepository,
	hub ws.Broadcaster,
	channelGetter ChannelGetter,
	permResolver ChannelPermResolver,
	backupHMACKey []byte,
) E2EEService {
	return &e2eeService{
		backupRepo:       backupRepo,
		groupSessionRepo: groupSessionRepo,
		hub:              hub,
		channelGetter:    channelGetter,
		permResolver:     permResolver,
		backupHMACKey:    backupHMACKey,
	}
}

func (s *e2eeService) UpsertKeyBackup(ctx context.Context, userID string, req *models.CreateKeyBackupRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}
	// P0-BD-01: stamp a server-side integrity MAC so at-rest tampering of the
	// opaque blob is detectable on read.
	mac := crypto.BackupHMAC(s.backupHMACKey, userID, req.Version, req.Algorithm, req.EncryptedData, req.Nonce, req.Salt)
	if err := s.backupRepo.Upsert(ctx, userID, req, mac); err != nil {
		return fmt.Errorf("failed to upsert key backup: %w", err)
	}
	return nil
}

func (s *e2eeService) GetKeyBackup(ctx context.Context, userID string) (*models.E2EEKeyBackup, error) {
	backup, err := s.backupRepo.GetByUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get key backup: %w", err)
	}
	if backup == nil {
		return nil, nil
	}
	// Integrity check (P0-BD-01). Legacy rows predating the MAC column have an
	// empty HMAC and are returned as-is (the client's AES-GCM tag still guards
	// them); they get re-MAC'd on the next upsert. A present-but-mismatched MAC
	// means the at-rest blob was tampered with — refuse to serve it and log.
	if backup.BackupHMAC != "" && !crypto.VerifyBackupHMAC(
		s.backupHMACKey, backup.BackupHMAC,
		backup.UserID, backup.Version, backup.Algorithm,
		backup.EncryptedData, backup.Nonce, backup.Salt,
	) {
		e2eeLogger.Error("SECURITY: key backup HMAC mismatch, refusing tampered blob", "user_id", userID)
		return nil, fmt.Errorf("%w: key backup failed integrity check", pkg.ErrInternal)
	}
	return backup, nil
}

func (s *e2eeService) DeleteKeyBackup(ctx context.Context, userID string) error {
	if err := s.backupRepo.Delete(ctx, userID); err != nil {
		return fmt.Errorf("failed to delete key backup: %w", err)
	}
	return nil
}

func (s *e2eeService) UpsertGroupSession(ctx context.Context, serverID, channelID, userID, deviceID string, req *models.CreateGroupSessionRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}
	if err := s.authorizeGroupSession(ctx, serverID, channelID, userID, true); err != nil {
		return err
	}
	if err := s.groupSessionRepo.Upsert(ctx, channelID, userID, deviceID, req); err != nil {
		return fmt.Errorf("failed to upsert group session: %w", err)
	}

	s.hub.BroadcastToServer(serverID, ws.Event{
		Op: ws.OpGroupSessionNew,
		Data: GroupSessionNewData{
			ChannelID:    channelID,
			SenderUserID: userID,
			SessionID:    req.SessionID,
		},
	})

	return nil
}

func (s *e2eeService) GetGroupSessions(ctx context.Context, serverID, channelID, userID string) ([]models.ChannelGroupSession, error) {
	if err := s.authorizeGroupSession(ctx, serverID, channelID, userID, false); err != nil {
		return nil, err
	}
	sessions, err := s.groupSessionRepo.GetByChannel(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("failed to get group sessions: %w", err)
	}
	if sessions == nil {
		sessions = []models.ChannelGroupSession{}
	}
	return sessions, nil
}

func (s *e2eeService) authorizeGroupSession(ctx context.Context, serverID, channelID, userID string, requireSend bool) error {
	channel, err := s.channelGetter.GetByID(ctx, channelID)
	if err != nil {
		return fmt.Errorf("failed to get channel: %w", err)
	}
	if channel.ServerID != serverID {
		return fmt.Errorf("%w: channel not found", pkg.ErrNotFound)
	}

	perms, err := s.permResolver.ResolveChannelPermissions(ctx, userID, channelID)
	if err != nil {
		return fmt.Errorf("failed to resolve channel permissions: %w", err)
	}
	if !perms.Has(models.PermViewChannel) || !perms.Has(models.PermReadMessages) {
		return fmt.Errorf("%w: read messages permission required", pkg.ErrForbidden)
	}
	if requireSend && !perms.Has(models.PermSendMessages) {
		return fmt.Errorf("%w: send messages permission required", pkg.ErrForbidden)
	}
	return nil
}

func (s *e2eeService) DeleteGroupSessionsByChannel(ctx context.Context, channelID string) error {
	if err := s.groupSessionRepo.DeleteByChannel(ctx, channelID); err != nil {
		return fmt.Errorf("failed to delete channel group sessions: %w", err)
	}
	return nil
}

func (s *e2eeService) DeleteGroupSessionsByUser(ctx context.Context, channelID, userID string) error {
	if err := s.groupSessionRepo.DeleteByUser(ctx, channelID, userID); err != nil {
		return fmt.Errorf("failed to delete user group sessions: %w", err)
	}
	return nil
}

// GroupSessionNewData is the payload for group_session_new events.
type GroupSessionNewData struct {
	ChannelID    string `json:"channel_id"`
	SenderUserID string `json:"sender_user_id"`
	SessionID    string `json:"session_id"`
}
