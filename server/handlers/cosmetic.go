package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/ratelimit"
	"github.com/argeinfina/hichat/services"
)

// cosmeticMaxBody caps the JSON body of the cosmetics write endpoints.
const cosmeticMaxBody = 4 << 10

// CosmeticHandler serves profile cosmetics. /api/users/me/cosmetics* are
// self-scoped (plain auth; a server scope additionally checks membership in
// the service); /api/servers/{serverId}/cosmetics is gated by membership.
type CosmeticHandler struct {
	svc          services.CosmeticService
	equipLimiter *ratelimit.MessageRateLimiter
}

func NewCosmeticHandler(svc services.CosmeticService, equipLimiter *ratelimit.MessageRateLimiter) *CosmeticHandler {
	return &CosmeticHandler{svc: svc, equipLimiter: equipLimiter}
}

// cosmeticErrorCodes maps the cosmetic sentinels to fixed messages
// (CWE-209, trap #245) and their COSMETIC_* codes. A missing item and a
// scope server the caller is not in share one 404.
var cosmeticErrorCodes = []struct {
	err    error
	status int
	msg    string
	code   string
}{
	{models.ErrCosmeticSlotsInvalid, http.StatusBadRequest, "invalid cosmetic slots", "COSMETIC_SLOTS_INVALID"},
	{models.ErrCosmeticSlotMismatch, http.StatusBadRequest, "cosmetic item does not fit this slot", "COSMETIC_SLOT_MISMATCH"},
	{models.ErrCosmeticScopeMismatch, http.StatusBadRequest, "a server cosmetic can only be worn on its own server", "COSMETIC_SCOPE_MISMATCH"},
	{models.ErrCosmeticNotOwned, http.StatusForbidden, "you do not own this cosmetic", "COSMETIC_NOT_OWNED"},
	{models.ErrCosmeticIDsInvalid, http.StatusBadRequest, "invalid user id list", "COSMETIC_IDS_INVALID"},
	{models.ErrCosmeticRequestInvalid, http.StatusBadRequest, "invalid request body", "BAD_REQUEST"},
	{models.ErrCosmeticNotFound, http.StatusNotFound, "not found", "NOT_FOUND"},
	{models.ErrCosmeticItemNotFound, http.StatusNotFound, "not found", "NOT_FOUND"},
}

// writeCosmeticError writes err from the fixed table; anything else goes
// through pkg.Error (5xx detail is redacted there).
func writeCosmeticError(w http.ResponseWriter, err error) {
	for _, c := range cosmeticErrorCodes {
		if errors.Is(err, c.err) {
			pkg.ErrorWithCode(w, c.status, c.msg, c.code)
			return
		}
	}
	pkg.Error(w, err)
}

// decodeCosmeticBody reads a JSON body of at most cosmeticMaxBody bytes
// with no unknown fields and nothing after the object.
func decodeCosmeticBody(w http.ResponseWriter, r *http.Request, dst any) error {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, cosmeticMaxBody))
	if err != nil {
		return models.ErrCosmeticRequestInvalid
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return models.ErrCosmeticRequestInvalid
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return models.ErrCosmeticRequestInvalid
	}
	return nil
}

// GetMine handles GET /api/users/me/cosmetics.
func (h *CosmeticHandler) GetMine(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	mine, err := h.svc.GetMine(r.Context(), user.ID)
	if err != nil {
		writeCosmeticError(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, mine)
}

// Equip handles PUT /api/users/me/cosmetics/equipped
// {scope: "global"|serverId, slots: {type: itemId|null}} -> 200 MyCosmetics.
func (h *CosmeticHandler) Equip(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	if uploadRateLimited(w, h.equipLimiter, user.ID) {
		return
	}
	var req models.EquipRequest
	if err := decodeCosmeticBody(w, r, &req); err != nil {
		writeCosmeticError(w, err)
		return
	}
	mine, err := h.svc.Equip(r.Context(), user.ID, &req)
	if err != nil {
		writeCosmeticError(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, mine)
}

// SetPlainServer handles PUT /api/users/me/cosmetics/plain-servers/{serverId}
// {plain: bool} -> 204. Not a member of serverId -> 404.
func (h *CosmeticHandler) SetPlainServer(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	if uploadRateLimited(w, h.equipLimiter, user.ID) {
		return
	}
	var req models.SetPlainServerRequest
	if err := decodeCosmeticBody(w, r, &req); err != nil {
		writeCosmeticError(w, err)
		return
	}
	if req.Plain == nil {
		writeCosmeticError(w, models.ErrCosmeticRequestInvalid)
		return
	}
	if err := h.svc.SetPlainServer(r.Context(), user.ID, r.PathValue("serverId"), *req.Plain); err != nil {
		writeCosmeticError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// LookupGlobal handles GET /api/users/cosmetics?ids=a,b -> {users: {id: slots}}
// (global slots only; 1-100 ids, duplicates collapsed).
func (h *CosmeticHandler) LookupGlobal(w http.ResponseWriter, r *http.Request) {
	if _, ok := r.Context().Value(UserContextKey).(*models.User); !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	raw := r.URL.Query().Get("ids")
	if raw == "" {
		writeCosmeticError(w, models.ErrCosmeticIDsInvalid)
		return
	}
	// Bound the split before allocating: more commas than the cap allows
	// is invalid however many duplicates it holds.
	if strings.Count(raw, ",") >= models.CosmeticLookupMaxIDs*4 {
		writeCosmeticError(w, models.ErrCosmeticIDsInvalid)
		return
	}
	res, err := h.svc.LookupGlobal(r.Context(), strings.Split(raw, ","))
	if err != nil {
		writeCosmeticError(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, res)
}

// ServerCosmetics handles GET /api/servers/{serverId}/cosmetics.
func (h *CosmeticHandler) ServerCosmetics(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}
	res, err := h.svc.ServerCosmetics(r.Context(), serverID)
	if err != nil {
		writeCosmeticError(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, res)
}
