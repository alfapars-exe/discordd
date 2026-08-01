package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type MemberHandler struct {
	memberService services.MemberService
}

func NewMemberHandler(memberService services.MemberService) *MemberHandler {
	return &MemberHandler{memberService: memberService}
}

// List handles GET /api/servers/{serverId}/members
func (h *MemberHandler) List(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	members, err := h.memberService.GetAll(r.Context(), serverID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, members)
}

// Get handles GET /api/servers/{serverId}/members/{id}
func (h *MemberHandler) Get(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	id := r.PathValue("id")

	member, err := h.memberService.GetByID(r.Context(), serverID, id)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, member)
}

// ModifyRoles handles PATCH /api/servers/{serverId}/members/{id}/roles
func (h *MemberHandler) ModifyRoles(w http.ResponseWriter, r *http.Request) {
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	targetID := r.PathValue("id")

	var req models.RoleModifyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	member, err := h.memberService.ModifyRoles(r.Context(), serverID, actor.ID, targetID, req.RoleIDs)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, member)
}

// Kick handles DELETE /api/servers/{serverId}/members/{id}
func (h *MemberHandler) Kick(w http.ResponseWriter, r *http.Request) {
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	targetID := r.PathValue("id")

	if err := h.memberService.Kick(r.Context(), serverID, actor.ID, targetID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "member kicked"})
}

// Ban handles POST /api/servers/{serverId}/members/{id}/ban
func (h *MemberHandler) Ban(w http.ResponseWriter, r *http.Request) {
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	targetID := r.PathValue("id")

	var req models.BanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.memberService.Ban(r.Context(), serverID, actor.ID, targetID, req.Reason, req.ResolvedExpiresAt()); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "member banned"})
}

// Timeout handles PUT /api/servers/{serverId}/members/{id}/timeout.
// Requires PermTimeoutMembers (enforced via authServerPerm in
// init_routes.go). Body: { "duration_seconds": int, "reason": string }.
func (h *MemberHandler) Timeout(w http.ResponseWriter, r *http.Request) {
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}
	targetID := r.PathValue("id")
	if targetID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "missing target user id")
		return
	}

	var req models.TimeoutRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.memberService.Timeout(r.Context(), serverID, actor.ID, targetID, req.ExpiresAt(), req.Reason); err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]string{"message": "member timed out"})
}

// SetNickname handles PATCH /api/servers/{serverId}/members/{id}/nickname.
// Self can always rename themselves. Renaming someone ELSE requires
// PermManageNicknames; the route layer (init_routes.go) enforces that
// branch — this handler accepts either case and trusts the caller.
//
// Body: { "nickname": "string|null" } — empty/blank/null all clear it.
func (h *MemberHandler) SetNickname(w http.ResponseWriter, r *http.Request) {
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}
	targetID := r.PathValue("id")
	if targetID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "missing target user id")
		return
	}

	var req models.NicknameRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if err := req.Validate(); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, err.Error())
		return
	}

	updated, err := h.memberService.SetNickname(r.Context(), serverID, actor.ID, targetID, req.Nickname)
	if err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, updated)
}

// RemoveTimeout handles DELETE /api/servers/{serverId}/members/{id}/timeout.
// Same permission gate as Timeout. No body required; the route alone is
// the intent. Idempotent — un-timing an untimed user is a no-op.
func (h *MemberHandler) RemoveTimeout(w http.ResponseWriter, r *http.Request) {
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}
	targetID := r.PathValue("id")
	if targetID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "missing target user id")
		return
	}
	if err := h.memberService.RemoveTimeout(r.Context(), serverID, actor.ID, targetID); err != nil {
		pkg.Error(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, map[string]string{"message": "timeout removed"})
}

// GetBans handles GET /api/servers/{serverId}/bans (requires BAN_MEMBERS).
func (h *MemberHandler) GetBans(w http.ResponseWriter, r *http.Request) {
	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	bans, err := h.memberService.GetBans(r.Context(), serverID)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, bans)
}

// Unban handles DELETE /api/servers/{serverId}/bans/{id} (requires BAN_MEMBERS).
func (h *MemberHandler) Unban(w http.ResponseWriter, r *http.Request) {
	actor, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	serverID, ok := r.Context().Value(ServerIDContextKey).(string)
	if !ok || serverID == "" {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "server context required")
		return
	}

	userID := r.PathValue("id")

	if err := h.memberService.Unban(r.Context(), serverID, actor.ID, userID); err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, map[string]string{"message": "member unbanned"})
}

// UpdateProfile handles PATCH /api/users/me/profile
// Global endpoint (not server-scoped).
func (h *MemberHandler) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok {
		pkg.ErrorWithMessage(w, http.StatusUnauthorized, "user not found in context")
		return
	}

	var req models.UpdateProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		pkg.ErrorWithMessage(w, http.StatusBadRequest, "invalid request body")
		return
	}
	// AvatarURL is silently discarded: Validate() never checks it, so a caller
	// could otherwise point avatar_url at an arbitrary /api/uploads path —
	// including someone else's orphaned private attachment — and launder it
	// into MediaAssetRepository.IsPublicAsset's positive public-asset check
	// (services/media_access_service.go), bypassing the fail-closed default.
	// The only legitimate way to set an avatar is handlers/avatar.go, which
	// calls MemberService.UpdateProfile directly and never goes through this
	// JSON body.
	req.AvatarURL = nil

	member, err := h.memberService.UpdateProfile(r.Context(), user.ID, &req)
	if err != nil {
		pkg.Error(w, err)
		return
	}

	pkg.JSON(w, http.StatusOK, member)
}
