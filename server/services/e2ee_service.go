package services

import (
	"context"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

var e2eeLogger = logx.Component("service.e2ee")

// PrekeyBundleProvider is the slice of DeviceRepository the E2EE service
// needs: verifying a caller's device ownership and fetching prekey bundles
// for the sender-key-recipients roster. Satisfied by repository.DeviceRepository.
//
// ListDeviceBundlesNoOTP, not GetPrekeyBundles, backs the roster (pentest
// C-03 follow-up finding 1): GetPrekeyBundles consumes a one-time prekey per
// device on every call, and the roster is fetched far more often than a real
// X3DH handshake — every call would otherwise drain the OTP pool.
type PrekeyBundleProvider interface {
	GetByUserAndDevice(ctx context.Context, userID, deviceID string) (*models.Device, error)
	ListDeviceBundlesNoOTP(ctx context.Context, userID string) ([]models.PrekeyBundle, error)
}

// ServerMemberLister lists a server's member user IDs (online or not) so the
// sender-key-recipients roster can reach offline members too. Satisfied by
// repository.ServerRepository.
type ServerMemberLister interface {
	ListMemberIDs(ctx context.Context, serverID string) ([]string, error)
}

// E2EEService handles key backup and Sender Key envelope distribution.
//
// Key Backup: encrypted key backup/restore via recovery password.
// The server stores opaque blobs only — it never sees the recovery password.
//
// Group Session (pentest C-03, closed): the sender seals its Sender Key
// distribution once per recipient device (a Signal PreKey/Whisper message)
// and uploads all envelopes together. The server stores N opaque envelopes
// instead of one shared plaintext blob, and GetGroupSessions only ever
// returns the envelopes sealed for the caller's own (user_id, device_id).
// See models.SenderKeyEnvelope for the wire format.
type E2EEService interface {
	UpsertKeyBackup(ctx context.Context, userID string, req *models.CreateKeyBackupRequest) error
	GetKeyBackup(ctx context.Context, userID string) (*models.E2EEKeyBackup, error)
	DeleteKeyBackup(ctx context.Context, userID string) error

	// UpsertGroupSession stores a v2 Sender Key distribution (one envelope per
	// recipient device). Broadcasts "group_session_new" to the envelope
	// recipients only, not the whole server.
	UpsertGroupSession(ctx context.Context, serverID, channelID, userID, deviceID string, req *models.CreateSenderKeyDistributionRequest) error
	// GetGroupSessions returns only the envelopes sealed for (userID, deviceID).
	// deviceID must belong to userID, or the call is forbidden.
	GetGroupSessions(ctx context.Context, serverID, channelID, userID, deviceID string) ([]models.SenderKeyEnvelopeResponse, error)
	// GetSenderKeyRecipients returns the prekey bundle roster a sender needs
	// to seal one envelope per recipient device: every device of every
	// channel member with read access, excluding the caller's own device.
	GetSenderKeyRecipients(ctx context.Context, serverID, channelID, userID, callerDeviceID string) ([]models.SenderKeyRecipient, error)
	DeleteGroupSessionsByChannel(ctx context.Context, channelID string) error
	DeleteGroupSessionsByUser(ctx context.Context, channelID, userID string) error
}

type e2eeService struct {
	backupRepo       repository.E2EEKeyBackupRepository
	groupSessionRepo repository.GroupSessionRepository
	deviceRepo       PrekeyBundleProvider
	memberLister     ServerMemberLister
	hub              ws.Broadcaster
	channelGetter    ChannelGetter
	permResolver     ChannelPermResolver
	backupHMACKey    []byte
}

func NewE2EEService(
	backupRepo repository.E2EEKeyBackupRepository,
	groupSessionRepo repository.GroupSessionRepository,
	deviceRepo PrekeyBundleProvider,
	memberLister ServerMemberLister,
	hub ws.Broadcaster,
	channelGetter ChannelGetter,
	permResolver ChannelPermResolver,
	backupHMACKey []byte,
) E2EEService {
	return &e2eeService{
		backupRepo:       backupRepo,
		groupSessionRepo: groupSessionRepo,
		deviceRepo:       deviceRepo,
		memberLister:     memberLister,
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

func (s *e2eeService) UpsertGroupSession(ctx context.Context, serverID, channelID, userID, deviceID string, req *models.CreateSenderKeyDistributionRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("%w: %s", pkg.ErrBadRequest, err.Error())
	}
	if err := s.authorizeGroupSession(ctx, serverID, channelID, userID, true); err != nil {
		return err
	}

	// BULGU 7 (pentest C-03 follow-up): verify the caller actually owns
	// deviceID before writing envelopes claimed to be sealed BY it — the read
	// path (GetGroupSessions) already checked this; the write path did not.
	if _, err := s.deviceRepo.GetByUserAndDevice(ctx, userID, deviceID); err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return fmt.Errorf("%w: device does not belong to caller", pkg.ErrForbidden)
		}
		return fmt.Errorf("failed to verify device ownership: %w", err)
	}

	// BULGU 2 (pentest C-03 follow-up): the client picks RecipientUserID for
	// every envelope, and the only DB-enforced check was "some real user
	// exists" (the FK). Reject any envelope addressed to a user outside the
	// same authorized roster GetSenderKeyRecipients would hand the sender —
	// otherwise a member can plant an envelope row for an arbitrary platform
	// user and trigger a group_session_new push to them, leaking "who
	// rotated when" metadata to someone who can't even read the channel.
	authorized, err := s.authorizedChannelRecipients(ctx, serverID, channelID)
	if err != nil {
		return err
	}
	for _, env := range req.Envelopes {
		if !authorized[env.RecipientUserID] {
			return fmt.Errorf("%w: recipient %s is not a member with read access to this channel", pkg.ErrBadRequest, env.RecipientUserID)
		}
	}

	if err := s.groupSessionRepo.Upsert(ctx, channelID, userID, deviceID, req); err != nil {
		return fmt.Errorf("failed to upsert group session: %w", err)
	}

	// Notify only the envelope recipients, not BroadcastToServer: everyone
	// else on the server wasn't sealed an envelope and couldn't resolve a
	// GetGroupSessions read anyway.
	recipients := make([]string, 0, len(req.Envelopes))
	seen := make(map[string]bool, len(req.Envelopes))
	for _, env := range req.Envelopes {
		if seen[env.RecipientUserID] {
			continue
		}
		seen[env.RecipientUserID] = true
		recipients = append(recipients, env.RecipientUserID)
	}
	s.hub.BroadcastToUsers(recipients, ws.Event{
		Op: ws.OpGroupSessionNew,
		Data: GroupSessionNewData{
			ChannelID:      channelID,
			SenderUserID:   userID,
			SenderDeviceID: deviceID,
			SessionID:      req.SessionID,
		},
	})

	return nil
}

func (s *e2eeService) GetGroupSessions(ctx context.Context, serverID, channelID, userID, deviceID string) ([]models.SenderKeyEnvelopeResponse, error) {
	if err := s.authorizeGroupSession(ctx, serverID, channelID, userID, false); err != nil {
		return nil, err
	}

	// The caller may only read envelopes sealed for a device it owns — a
	// stolen session cookie must not let an attacker read another device's
	// (still individually-sealed) envelopes just by naming it.
	if _, err := s.deviceRepo.GetByUserAndDevice(ctx, userID, deviceID); err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil, fmt.Errorf("%w: device does not belong to caller", pkg.ErrForbidden)
		}
		return nil, fmt.Errorf("failed to verify device ownership: %w", err)
	}

	envelopes, err := s.groupSessionRepo.GetForRecipient(ctx, channelID, userID, deviceID)
	if err != nil {
		return nil, fmt.Errorf("failed to get group sessions: %w", err)
	}
	if envelopes == nil {
		envelopes = []models.SenderKeyEnvelopeResponse{}
	}
	return envelopes, nil
}

// GetSenderKeyRecipients resolves the roster a sender needs to seal one
// Sender Key envelope per recipient device: every device belonging to every
// server member with read access to the channel (including the caller's own
// OTHER devices), excluding the caller's own calling device.
//
// Pattern source: messageService.allowedViewers (message_service.go) — same
// bulk-permission-resolve shape, but over all server members rather than
// only online ones, since offline recipients still need envelopes waiting
// for them.
func (s *e2eeService) GetSenderKeyRecipients(ctx context.Context, serverID, channelID, userID, callerDeviceID string) ([]models.SenderKeyRecipient, error) {
	if err := s.authorizeGroupSession(ctx, serverID, channelID, userID, true); err != nil {
		return nil, err
	}

	// BULGU 7 (pentest C-03 follow-up): same device-ownership gate as the
	// write path — a caller must own callerDeviceID to resolve "who else
	// needs an envelope from me" on its behalf.
	if _, err := s.deviceRepo.GetByUserAndDevice(ctx, userID, callerDeviceID); err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return nil, fmt.Errorf("%w: device does not belong to caller", pkg.ErrForbidden)
		}
		return nil, fmt.Errorf("failed to verify device ownership: %w", err)
	}

	authorized, err := s.authorizedChannelRecipients(ctx, serverID, channelID)
	if err != nil {
		return nil, err
	}

	recipients := make([]models.SenderKeyRecipient, 0, len(authorized))
	for memberID := range authorized {
		// BULGU 1 (pentest C-03 follow-up): ListDeviceBundlesNoOTP, not
		// GetPrekeyBundles — this roster is re-fetched on every "stale"
		// channel (far more often than a genuine first contact) and must not
		// drain the one-time-prekey pool. A sender that genuinely needs a
		// fresh OTP for X3DH still gets one via GetPrekeyBundles through
		// /api/users/{userId}/prekey-bundles (behind deviceEnum, and the
		// prekey_low refill signal fires there).
		bundles, err := s.deviceRepo.ListDeviceBundlesNoOTP(ctx, memberID)
		if err != nil {
			return nil, fmt.Errorf("failed to get prekey bundles for user %s: %w", memberID, err)
		}
		for _, b := range bundles {
			if memberID == userID && b.DeviceID == callerDeviceID {
				continue // caller's own calling device does not need an envelope from itself
			}
			recipients = append(recipients, models.SenderKeyRecipient{
				UserID:          memberID,
				DeviceID:        b.DeviceID,
				RegistrationID:  b.RegistrationID,
				IdentityKey:     b.IdentityKey,
				SigningKey:      b.SigningKey,
				SignedPrekeyID:  b.SignedPrekeyID,
				SignedPrekey:    b.SignedPrekey,
				SignedPrekeySig: b.SignedPrekeySig,
				OneTimePrekeyID: b.OneTimePrekeyID,
				OneTimePrekey:   b.OneTimePrekey,
			})
		}
	}

	return recipients, nil
}

// authorizedChannelRecipients resolves the set of user IDs allowed to read
// channelID: every server member with PermCanReadChannel. Shared by
// GetSenderKeyRecipients (the roster itself) and UpsertGroupSession (BULGU 2,
// pentest C-03 follow-up: rejecting envelopes addressed outside this exact
// set) so both enforce identically the same audience for the same channel.
func (s *e2eeService) authorizedChannelRecipients(ctx context.Context, serverID, channelID string) (map[string]bool, error) {
	memberIDs, err := s.memberLister.ListMemberIDs(ctx, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to list server members: %w", err)
	}

	perms, err := s.permResolver.ResolveChannelPermissionsBulk(ctx, channelID, memberIDs)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve channel permissions: %w", err)
	}

	authorized := make(map[string]bool, len(memberIDs))
	for _, memberID := range memberIDs {
		if models.PermCanReadChannel(perms[memberID]) {
			authorized[memberID] = true
		}
	}
	return authorized, nil
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
	if !models.PermCanReadChannel(perms) {
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
	ChannelID      string `json:"channel_id"`
	SenderUserID   string `json:"sender_user_id"`
	SenderDeviceID string `json:"sender_device_id"`
	SessionID      string `json:"session_id"`
}
