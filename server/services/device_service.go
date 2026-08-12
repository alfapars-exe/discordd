package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

var deviceLogger = logx.Component("service.device")

// PrekeyLowThreshold — when prekey pool drops below this, a "prekey_low" WS event is sent.
const PrekeyLowThreshold = 10

// UserServerLister lists the server IDs a user belongs to. Used to fan out
// device add/remove broadcasts to every server the user shares with other
// members, not just back to the device owner — see BULGU 4 (pentest C-03
// follow-up finding 4). Satisfied by repository.ServerRepository.
type UserServerLister interface {
	GetMemberServerIDs(ctx context.Context, userID string) ([]string, error)
}

// DeviceService handles E2EE device registration and prekey management.
type DeviceService interface {
	RegisterDevice(ctx context.Context, userID string, req *models.RegisterDeviceRequest) (*models.Device, error)
	ListDevices(ctx context.Context, userID string) ([]models.Device, error)
	ListPublicDevices(ctx context.Context, userID string) ([]models.DevicePublicInfo, error)
	DeleteDevice(ctx context.Context, userID, deviceID string) error
	UpdateSignedPrekey(ctx context.Context, userID, deviceID string, req *models.UpdateSignedPrekeyRequest) error
	UploadPrekeys(ctx context.Context, userID, deviceID string, req *models.UploadPrekeysRequest) error
	// GetPrekeyBundles returns prekey bundles for all of a user's devices.
	// Called when initiating first message — each device gets separate encryption.
	GetPrekeyBundles(ctx context.Context, userID string) ([]models.PrekeyBundle, error)
	GetPrekeyCount(ctx context.Context, userID, deviceID string) (int, error)
}

type deviceService struct {
	deviceRepo   repository.DeviceRepository
	hub          ws.Broadcaster
	serverLister UserServerLister
}

func NewDeviceService(deviceRepo repository.DeviceRepository, hub ws.Broadcaster, serverLister UserServerLister) DeviceService {
	return &deviceService{
		deviceRepo:   deviceRepo,
		hub:          hub,
		serverLister: serverLister,
	}
}

func (s *deviceService) RegisterDevice(ctx context.Context, userID string, req *models.RegisterDeviceRequest) (*models.Device, error) {
	if err := req.Validate(); err != nil {
		return nil, fmt.Errorf("%w: %s", pkg.ErrBadRequest, pkg.ErrText(err))
	}

	device := &models.Device{
		UserID:          userID,
		DeviceID:        req.DeviceID,
		IdentityKey:     req.IdentityKey,
		SignedPrekey:    req.SignedPrekey,
		SignedPrekeyID:  req.SignedPrekeyID,
		SignedPrekeySig: req.SignedPrekeySig,
		RegistrationID:  req.RegistrationID,
	}
	if req.DisplayName != "" {
		device.DisplayName = &req.DisplayName
	}
	if req.SigningKey != "" {
		device.SigningKey = &req.SigningKey
	}

	// UPSERT — updates if same device_id exists
	if err := s.deviceRepo.Register(ctx, device); err != nil {
		return nil, fmt.Errorf("failed to register device: %w", err)
	}

	if len(req.OneTimePrekeys) > 0 {
		if err := s.deviceRepo.UploadPrekeys(ctx, userID, req.DeviceID, req.OneTimePrekeys); err != nil {
			return nil, fmt.Errorf("failed to upload initial prekeys: %w", err)
		}
	}

	// BULGU 4 (pentest C-03 follow-up): a new device is invisible to a
	// shared server otherwise -- senders only learn about it when unrelated
	// traffic (e.g. a member_update) happens to mark their sender-key roster
	// stale. BroadcastToUser still covers the device's own other sessions.
	event := ws.Event{
		Op:   ws.OpDeviceListUpdate,
		Data: DeviceListUpdateData{UserID: userID, Action: "added", DeviceID: req.DeviceID},
	}
	s.hub.BroadcastToUser(userID, event)
	s.broadcastToUserServers(ctx, userID, event)

	return device, nil
}

func (s *deviceService) ListDevices(ctx context.Context, userID string) ([]models.Device, error) {
	devices, err := s.deviceRepo.ListByUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list devices: %w", err)
	}
	if devices == nil {
		devices = []models.Device{}
	}
	return devices, nil
}

func (s *deviceService) ListPublicDevices(ctx context.Context, userID string) ([]models.DevicePublicInfo, error) {
	devices, err := s.deviceRepo.ListPublicByUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list public devices: %w", err)
	}
	if devices == nil {
		devices = []models.DevicePublicInfo{}
	}
	return devices, nil
}

func (s *deviceService) DeleteDevice(ctx context.Context, userID, deviceID string) error {
	if err := s.deviceRepo.Delete(ctx, userID, deviceID); err != nil {
		return fmt.Errorf("failed to delete device: %w", err)
	}

	// BULGU 4 (pentest C-03 follow-up): fan out the removal the same way as
	// the add above -- other members' senders should stop sealing envelopes
	// for a device that's gone.
	event := ws.Event{
		Op:   ws.OpDeviceListUpdate,
		Data: DeviceListUpdateData{UserID: userID, Action: "removed", DeviceID: deviceID},
	}
	s.hub.BroadcastToUser(userID, event)
	s.broadcastToUserServers(ctx, userID, event)

	return nil
}

func (s *deviceService) UpdateSignedPrekey(ctx context.Context, userID, deviceID string, req *models.UpdateSignedPrekeyRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("%w: %s", pkg.ErrBadRequest, pkg.ErrText(err))
	}

	if err := s.deviceRepo.UpdateSignedPrekey(ctx, userID, deviceID, req); err != nil {
		return fmt.Errorf("failed to update signed prekey: %w", err)
	}

	s.hub.BroadcastToUser(userID, ws.Event{
		Op:   ws.OpDeviceKeyChange,
		Data: DeviceKeyChangeData{UserID: userID, DeviceID: deviceID},
	})

	return nil
}

func (s *deviceService) UploadPrekeys(ctx context.Context, userID, deviceID string, req *models.UploadPrekeysRequest) error {
	if err := req.Validate(); err != nil {
		return fmt.Errorf("%w: %s", pkg.ErrBadRequest, pkg.ErrText(err))
	}

	if err := s.deviceRepo.UploadPrekeys(ctx, userID, deviceID, req.OneTimePrekeys); err != nil {
		return fmt.Errorf("failed to upload prekeys: %w", err)
	}
	return nil
}

func (s *deviceService) GetPrekeyBundles(ctx context.Context, userID string) ([]models.PrekeyBundle, error) {
	bundles, err := s.deviceRepo.GetPrekeyBundles(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get prekey bundles: %w", err)
	}

	// Check prekey pool levels after consumption
	s.checkPrekeyLevels(ctx, userID)

	return bundles, nil
}

func (s *deviceService) GetPrekeyCount(ctx context.Context, userID, deviceID string) (int, error) {
	count, err := s.deviceRepo.CountPrekeys(ctx, userID, deviceID)
	if err != nil {
		return 0, fmt.Errorf("failed to count prekeys: %w", err)
	}
	return count, nil
}

// checkPrekeyLevels sends "prekey_low" events for devices below threshold.
func (s *deviceService) checkPrekeyLevels(ctx context.Context, userID string) {
	devices, err := s.deviceRepo.ListByUser(ctx, userID)
	if err != nil {
		deviceLogger.Error("failed to list devices for prekey check", "err", pkg.ErrText(err))
		return
	}

	for _, d := range devices {
		count, err := s.deviceRepo.CountPrekeys(ctx, userID, d.DeviceID)
		if err != nil {
			deviceLogger.Error("failed to count prekeys for device", "device_id", d.DeviceID, "err", pkg.ErrText(err))
			continue
		}

		if count < PrekeyLowThreshold {
			s.hub.BroadcastToUser(userID, ws.Event{
				Op: ws.OpPrekeyLow,
				Data: PrekeyLowData{
					DeviceID:  d.DeviceID,
					Remaining: count,
				},
			})
		}
	}
}

// broadcastToUserServers fans out event to every server userID belongs to,
// in addition to the direct-to-owner BroadcastToUser call already made by
// the caller. Best-effort: a failure to list the user's servers is logged,
// not returned -- the device write it follows already succeeded, and a
// missed broadcast must never turn that into an error response.
func (s *deviceService) broadcastToUserServers(ctx context.Context, userID string, event ws.Event) {
	if s.serverLister == nil {
		return
	}
	serverIDs, err := s.serverLister.GetMemberServerIDs(ctx, userID)
	if err != nil {
		deviceLogger.Error("failed to list user servers for device broadcast", "user_id", userID, "err", pkg.ErrText(err))
		return
	}
	for _, serverID := range serverIDs {
		s.hub.BroadcastToServer(serverID, event)
	}
}

// DeviceListUpdateData is the payload for device_list_update events.
type DeviceListUpdateData struct {
	UserID   string `json:"user_id"`
	Action   string `json:"action"` // "added" or "removed"
	DeviceID string `json:"device_id"`
}

// DeviceKeyChangeData is the payload for device_key_change events.
type DeviceKeyChangeData struct {
	UserID   string `json:"user_id"`
	DeviceID string `json:"device_id"`
}

// PrekeyLowData is the payload for prekey_low events.
type PrekeyLowData struct {
	DeviceID  string `json:"device_id"`
	Remaining int    `json:"remaining"`
}
