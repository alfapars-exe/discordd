package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
)

type MusicVoicePresence interface{ GetUserVoiceChannelID(string) string }

var errMusicPlayRateLimited = errors.New("music play resource budget exceeded")

type MusicAccessDependencies struct {
	Channels services.ChannelGetter
	Voice    MusicVoicePresence
	Sessions MusicSessionValidator
	Members  MusicServerMembership
}

func musicControlError(w http.ResponseWriter, err error) {
	if errors.Is(err, errMusicPlayRateLimited) {
		pkg.ErrorWithMessage(w, http.StatusTooManyRequests, "too many play requests, please wait")
		return
	}
	if errors.Is(err, services.ErrMusicProtocolRequired) {
		pkg.ErrorWithCode(w, http.StatusPreconditionRequired, "music protocol 2 metadata required", "MUSIC_PROTOCOL_REQUIRED")
		return
	}
	pkg.Error(w, err)
}

func (h *MusicHandler) AdoptControl(w http.ResponseWriter, r *http.Request) {
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil {
		pkg.Error(w, pkg.ErrUnauthorized)
		return
	}
	if err := h.requirePerm(r, user.ID, r.PathValue("channelId"), models.PermSpeak); err != nil {
		pkg.Error(w, err)
		return
	}
	guarded, ok := h.music.(services.GuardedMusicBotService)
	if !ok {
		pkg.ErrorWithCode(w, http.StatusServiceUnavailable, "music protocol unavailable", "MUSIC_PROTOCOL_REQUIRED")
		return
	}
	head, err := guarded.AdoptControl(r.Context(), r.PathValue("channelId"))
	if err != nil {
		musicControlError(w, err)
		return
	}
	pkg.JSON(w, http.StatusOK, head)
}

// guardedCommand handles protocol 2 before the legacy decoder. Missing metadata
// never downgrades an adopted channel. The old endpoint/response shapes remain
// available only on channels which have never explicitly adopted protocol 2.
func (h *MusicHandler) guardedCommand(w http.ResponseWriter, r *http.Request, action string, permission models.Permission) bool {
	guarded, ok := h.music.(services.GuardedMusicBotService)
	if !ok {
		return false
	}
	var command services.MusicCommand
	if r.Method == http.MethodDelete {
		q := r.URL.Query()
		command.SessionID = q.Get("session_id")
		command.RequestID = q.Get("request_id")
		command.QueueItemID = r.PathValue("queueItemId")
		if raw, exists := q["expected_revision"]; exists {
			v, err := strconv.ParseUint(raw[0], 10, 64)
			if err != nil {
				pkg.Error(w, pkg.ErrBadRequest)
				return true
			}
			command.ExpectedRevision = &v
		}
	} else if r.Body != nil {
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
		if err != nil {
			pkg.Error(w, pkg.ErrBadRequest)
			return true
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		if len(bytes.TrimSpace(raw)) > 0 && json.Unmarshal(raw, &command) != nil {
			pkg.Error(w, pkg.ErrBadRequest)
			return true
		}
	}
	metadata := command.SessionID != "" || command.RequestID != "" || command.ExpectedRevision != nil || command.ExpectedQueueItemID != nil
	if !metadata {
		if err := guarded.CheckLegacyControl(r.Context(), r.PathValue("channelId")); err != nil {
			musicControlError(w, err)
			return true
		}
		return false
	}
	if command.SessionID == "" || command.RequestID == "" || command.ExpectedRevision == nil {
		musicControlError(w, services.ErrMusicProtocolRequired)
		return true
	}
	user, ok := r.Context().Value(UserContextKey).(*models.User)
	if !ok || user == nil {
		pkg.Error(w, pkg.ErrUnauthorized)
		return true
	}
	if err := h.requirePerm(r, user.ID, r.PathValue("channelId"), permission); err != nil {
		pkg.Error(w, err)
		return true
	}
	if action == "play" {
		command.BeforeNewWork = func() error {
			if h.playLimiter != nil && !h.playLimiter.Allow(user.ID) {
				return errMusicPlayRateLimited
			}
			return nil
		}
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(playWriteDeadline))
		command.URL = strings.TrimSpace(command.URL)
		if !strings.HasPrefix(command.URL, "https://") && !strings.HasPrefix(command.URL, "http://") {
			pkg.Error(w, pkg.ErrBadRequest)
			return true
		}
	}
	command.Action = action
	ctx, err := h.musicAccessContext(r, user.ID, r.PathValue("channelId"), permission)
	if err != nil {
		pkg.Error(w, err)
		return true
	}
	result, err := guarded.ApplyMusicCommand(ctx, user.ID, r.PathValue("channelId"), command)
	if err != nil {
		if code := services.MusicErrorCode(err); code != "" {
			pkg.ErrorWithCode(w, http.StatusBadGateway, "failed to resolve YouTube track", code)
		} else {
			musicControlError(w, err)
		}
		return true
	}
	pkg.JSON(w, http.StatusOK, result)
	return true
}
