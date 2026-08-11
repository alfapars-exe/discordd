package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
)

// maxGroupSessionBody bounds a group-session distribution upload (pentest
// C-03 follow-up finding 3): the JSON body is parsed twice (a raw
// map[string]json.RawMessage legacy-field sniff, then the typed struct), so
// an unbounded body is roughly a 3x memory amplification per request on top
// of being unbounded in the first place. models.CreateSenderKeyDistributionRequest.Validate
// adds the precise per-field caps (envelope count, ciphertext length); this
// is the coarse outer guard that rejects an oversized body before either
// parse even runs.
const maxGroupSessionBody = 1 << 20 // 1 MiB

// maxKeyBackupBody bounds a key-backup upsert (resource-scan 2026-07-31,
// finding N-14): CreateKeyBackupRequest.EncryptedData carries the base64 of a
// user's entire E2EE session state and was previously decoded with no cap at
// all — the largest unbounded authenticated JSON body in the codebase. 4 MiB
// sits under the global 8 MiB request-body cap (middleware/body_limit.go) but
// is generous enough for a full session backup.
const maxKeyBackupBody = 4 << 20 // 4 MiB

// E2EEHandler handles E2EE key backup and Sender Key envelope distribution.
type E2EEHandler struct {
	e2eeService services.E2EEService
	// groupSessionLimiter throttles CreateGroupSession (pentest C-03 follow-up
	// finding 3): unrate-limited, an authenticated member could write
	// unbounded envelope rows and trigger a "1 POST -> N recipient GETs"
	// notification fan-out repeatedly. Sized like uploadLimiter (init_services.go):
	// distributions are re-sealed per stale channel, not per message, so
	// legitimate bursts stay well under 20/min even after a role/profile
	// change marks several channels stale at once.
	groupSessionLimiter *ratelimit.MessageRateLimiter
}

func NewE2EEHandler(e2eeService services.E2EEService, groupSessionLimiter *ratelimit.MessageRateLimiter) *E2EEHandler {
	return &E2EEHandler{e2eeService: e2eeService, groupSessionLimiter: groupSessionLimiter}
}

// ── Key Backup Endpoints ──

// UpsertKeyBackup creates or updates the user's encrypted key backup.
// Server stores an opaque blob -- cannot read the keys without the recovery password.
// PUT /api/e2ee/key-backup
func (h *E2EEHandler) UpsertKeyBackup(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxKeyBackupBody)

	var req models.CreateKeyBackupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.e2eeService.UpsertKeyBackup(r.Context(), user.ID, &req); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, nil)
}

// GetKeyBackup returns the user's key backup.
// Returns 200 + null if no backup exists (backup is optional).
// GET /api/e2ee/key-backup
func (h *E2EEHandler) GetKeyBackup(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	backup, err := h.e2eeService.GetKeyBackup(r.Context(), user.ID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, backup)
}

// DeleteKeyBackup -- DELETE /api/e2ee/key-backup
func (h *E2EEHandler) DeleteKeyBackup(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	if err := h.e2eeService.DeleteKeyBackup(r.Context(), user.ID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, nil)
}

// ── Group Session Endpoints (pentest C-03: per-recipient sealed envelopes) ──

// groupSessionRequest carries the four values every group-session handler
// needs: the authenticated user, the validated server context, the channel
// path param, and the caller's device_id query param.
type groupSessionRequest struct {
	user      *models.User
	serverID  string
	channelID string
	deviceID  string
}

// readGroupSessionRequest reads and validates the fields shared by every
// group-session handler (CreateGroupSession, GetGroupSessions,
// GetSenderKeyRecipients), writing the matching error response itself on
// failure. ok is false when a response has ALREADY been written -- the
// caller must return immediately without writing another one.
func readGroupSessionRequest(w http.ResponseWriter, r *http.Request) (groupSessionRequest, bool) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return groupSessionRequest{}, false
	}

	channelID := r.PathValue("channelId")
	if channelID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "channel_id is required")
		return groupSessionRequest{}, false
	}
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context missing")
		return groupSessionRequest{}, false
	}

	deviceID := r.URL.Query().Get("device_id")
	if deviceID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "device_id query param is required")
		return groupSessionRequest{}, false
	}

	return groupSessionRequest{user: user, serverID: serverID, channelID: channelID, deviceID: deviceID}, true
}

// CreateGroupSession stores a Sender Key distribution as N opaque envelopes,
// one per recipient device. version must be 2 -- there is no compatibility
// path for the legacy single-blob format: a request carrying the old
// "session_data" field is rejected outright (400), never accepted.
// POST /api/servers/{serverId}/channels/{channelId}/group-sessions
func (h *E2EEHandler) CreateGroupSession(w http.ResponseWriter, r *http.Request) {
	gsReq, ok := readGroupSessionRequest(w, r)
	if !ok {
		return
	}
	user, serverID, channelID, deviceID := gsReq.user, gsReq.serverID, gsReq.channelID, gsReq.deviceID

	if h.groupSessionLimiter != nil && !h.groupSessionLimiter.Allow(user.ID) {
		retryAfter := h.groupSessionLimiter.CooldownSeconds(user.ID)
		w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests,
			fmt.Sprintf("too many group session uploads, please wait %s",
				ratelimit.FormatRetryMessage(retryAfter)))
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxGroupSessionBody)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Legacy-client sniff: a "session_data" field means a pre-C-03 client is
	// still uploading a single shared plaintext blob. Reject before it ever
	// reaches Validate/the repository -- there is no migration branch.
	var rawFields map[string]json.RawMessage
	if err := json.Unmarshal(body, &rawFields); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if _, hasLegacyField := rawFields["session_data"]; hasLegacyField {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "session_data is no longer accepted; upload per-recipient envelopes (version 2)")
		return
	}

	var req models.CreateSenderKeyDistributionRequest
	if err := json.Unmarshal(body, &req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := h.e2eeService.UpsertGroupSession(r.Context(), serverID, channelID, user.ID, deviceID, &req); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusCreated, nil)
}

// GetGroupSessions returns only the Sender Key envelopes sealed for the
// caller's own (user_id, device_id) -- never another recipient's ciphertext.
// device_id is required; it must belong to the authenticated caller (403 if not).
// GET /api/servers/{serverId}/channels/{channelId}/group-sessions
func (h *E2EEHandler) GetGroupSessions(w http.ResponseWriter, r *http.Request) {
	gsReq, ok := readGroupSessionRequest(w, r)
	if !ok {
		return
	}

	sessions, err := h.e2eeService.GetGroupSessions(r.Context(), gsReq.serverID, gsReq.channelID, gsReq.user.ID, gsReq.deviceID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, sessions)
}

// GetSenderKeyRecipients returns the prekey bundle roster a sender needs to
// seal one Sender Key envelope per recipient device: every device of every
// channel member with read access, excluding the caller's own calling
// device (its other devices ARE included).
// GET /api/servers/{serverId}/channels/{channelId}/sender-key-recipients?device_id=<callerDeviceId>
func (h *E2EEHandler) GetSenderKeyRecipients(w http.ResponseWriter, r *http.Request) {
	gsReq, ok := readGroupSessionRequest(w, r)
	if !ok {
		return
	}

	recipients, err := h.e2eeService.GetSenderKeyRecipients(r.Context(), gsReq.serverID, gsReq.channelID, gsReq.user.ID, gsReq.deviceID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, recipients)
}
