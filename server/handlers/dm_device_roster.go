package handlers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type dmRosterDeviceLister interface {
	ListDevices(context.Context, string) ([]models.Device, error)
}

type DMDeviceRosterHandler struct {
	access  services.DMDeviceRosterAccess
	devices dmRosterDeviceLister
}

func NewDMDeviceRosterHandler(access services.DMDeviceRosterAccess, devices dmRosterDeviceLister) *DMDeviceRosterHandler {
	return &DMDeviceRosterHandler{access: access, devices: devices}
}

// Get reads a fresh conversation roster without consuming a prekey or exposing
// key material. Existing public key-enumeration endpoints retain their limits.
func (h *DMDeviceRosterHandler) Get(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	members, err := h.access.GetDeviceRosterMembers(r.Context(), user.ID, r.PathValue("channelId"))
	if err != nil {
		pkg.Error(w, err)
		return
	}
	result, err := readDeviceRoster(r.Context(), h.devices, members)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, result)
}

// readDeviceRoster collects metadata completely before callers write a response.
func readDeviceRoster(ctx context.Context, lister dmRosterDeviceLister, members []string) (*models.DMDeviceRoster, error) {
	result := &models.DMDeviceRoster{Version: 1, Members: make([]models.DMDeviceRosterMember, 0, len(members))}
	for _, member := range members {
		devices, err := lister.ListDevices(ctx, member)
		if err != nil {
			return nil, fmt.Errorf("failed to read conversation device roster: %w", err)
		}
		references := make([]models.DMDeviceRosterReference, 0, len(devices))
		for _, device := range devices {
			// v1 canonical recipe shared with clients: SHA256 of the domain prefix
			// plus JSON [identity_key, signing_key-or-null, registration_id]. Rotating
			// signed/one-time prekeys does not invalidate an established ratchet.
			encoded, _ := json.Marshal([]any{device.IdentityKey, device.SigningKey, device.RegistrationID})
			digest := sha256.Sum256(append([]byte("hichat-device-roster-v1\x00"), encoded...))
			references = append(references, models.DMDeviceRosterReference{DeviceID: device.DeviceID, KeyRevision: hex.EncodeToString(digest[:])})
		}
		sort.Slice(references, func(i, j int) bool { return references[i].DeviceID < references[j].DeviceID })
		result.Members = append(result.Members, models.DMDeviceRosterMember{UserID: member, Devices: references})
	}
	return result, nil
}
