package ws

import (
	"context"
	"net/http"
	"net/url"
	"os"

	"github.com/gorilla/websocket"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
)

// handlerLogger tags every connection-upgrade log line ("ws.handler").
var handlerLogger = logx.Component("ws.handler")

// TokenValidator validates JWT tokens for WS connections.
// Defined here (not importing services.AuthService) to avoid circular dependency.
type TokenValidator interface {
	ValidateAccessToken(tokenString string) (*models.TokenClaims, error)
}

// BanChecker checks if a user is banned. Avoids circular ws -> services dependency.
type BanChecker interface {
	IsBanned(ctx context.Context, userID string) (bool, error)
}

// VoiceStatesProvider returns all active voice states for the ready event.
// Includes screen-share viewer maps so a client joining mid-session sees
// "who is already watching X" instead of having to wait for the next
// join/leave delta.
type VoiceStatesProvider interface {
	GetAllVoiceStates() []models.VoiceState
	GetAllScreenShareViewers() map[string][]string
}

// UserInfoProvider fetches user profile from DB for Hub cache.
// JWT claims only contain userID + username; display_name/avatar_url need DB lookup.
type UserInfoProvider interface {
	GetByID(ctx context.Context, id string) (*models.User, error)
}

// ServerListProvider returns the user's server list for the ready event and
// client.serverIDs (BroadcastToServer filtering).
type ServerListProvider interface {
	GetUserServers(ctx context.Context, userID string) ([]models.ServerListItem, error)
}

// MuteChecker returns muted server IDs for the ready event.
type MuteChecker interface {
	GetMutedServerIDs(ctx context.Context, userID string) ([]string, error)
}

// ChannelMuteChecker returns muted channel IDs for the ready event.
type ChannelMuteChecker interface {
	GetMutedChannelIDs(ctx context.Context, userID string) ([]string, error)
}

// AppLogger writes structured app logs asynchronously. ISP interface to avoid circular dependency.
type AppLogger interface {
	Log(level models.LogLevel, category models.LogCategory, userID, serverID *string, message string, metadata map[string]string)
}

// AllowedOrigins is set by main.go at startup to share the same origin
// whitelist between HTTP CORS and WebSocket upgrade.
// Electron production uses file:// protocol which sends "null" as Origin.
var AllowedOrigins []string

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		handlerLogger.Debug("check origin called", "origin", origin, "host", r.Host)
		// No Origin header = same-origin request (non-browser or same host)
		if origin == "" {
			return true
		}
		// Electron desktop sends "file://" or "null" as Origin. These are
		// non-browser clients and are allowed here: every WS connection must
		// present a one-shot ticket (or opted-in legacy token) in
		// HandleConnection, so a malicious web page cannot hijack a session
		// via these origins — it cannot obtain a valid ticket cross-origin.
		// Real browser origins (which can never be spoofed to "file://"/"null"
		// from a normal page) are still checked strictly below.
		if origin == "null" || origin == "file://" {
			return true
		}
		// Same-origin: origin host matches request Host header
		if u, err := url.Parse(origin); err == nil && u.Host == r.Host {
			return true
		}
		for _, allowed := range AllowedOrigins {
			if origin == allowed {
				return true
			}
		}
		handlerLogger.Warn("rejected connection: origin not allowed", "origin", origin)
		return false
	},
}

// TicketConsumer exchanges a short-lived WS connect ticket for a userID
// (one-shot, ~30s TTL). See services/ws_ticket_service.go for the
// rationale (keeps the long-lived JWT out of WS URL query strings).
// nil is acceptable — the handler then falls back to the legacy
// `?token=JWT` query path for clients that haven't been upgraded yet.
type TicketConsumer interface {
	Consume(ticket string) (string, error)
}

// Handler handles WebSocket connection upgrades.
type Handler struct {
	hub                 *Hub
	tokenValidator      TokenValidator
	ticketConsumer      TicketConsumer
	banChecker          BanChecker
	voiceStatesProvider VoiceStatesProvider
	userInfoProvider    UserInfoProvider
	serverListProvider  ServerListProvider
	muteChecker         MuteChecker
	channelMuteChecker  ChannelMuteChecker
	botValidator        BotTokenValidator
}

func NewHandler(
	hub *Hub,
	tokenValidator TokenValidator,
	ticketConsumer TicketConsumer,
	banChecker BanChecker,
	voiceStatesProvider VoiceStatesProvider,
	userInfoProvider UserInfoProvider,
	serverListProvider ServerListProvider,
	muteChecker MuteChecker,
	channelMuteChecker ChannelMuteChecker,
	botValidator BotTokenValidator,
) *Handler {
	return &Handler{
		hub:                 hub,
		tokenValidator:      tokenValidator,
		ticketConsumer:      ticketConsumer,
		banChecker:          banChecker,
		voiceStatesProvider: voiceStatesProvider,
		userInfoProvider:    userInfoProvider,
		serverListProvider:  serverListProvider,
		muteChecker:         muteChecker,
		channelMuteChecker:  channelMuteChecker,
		botValidator:        botValidator,
	}
}

// wsTokenRevoked reports whether a WS connection must be rejected because
// the presented access token predates the user's current token_version —
// the revocation signal bumped by "logout from all devices", password
// change, and refresh-token-reuse detection.
//
// The ticket path is EXEMPT. A ticket is only ever minted by the
// authenticated POST /api/auth/ws-ticket endpoint, which runs behind
// AuthMiddleware and has therefore ALREADY applied this exact gate against
// the caller's real token. HandleConnection synthesizes ticket claims with
// no token_version (the int zero value), so applying the `<` check to them
// would reject every user whose token_version has ever been incremented —
// i.e. anyone who changed their password or logged out everywhere could
// authenticate over HTTP yet never open a WebSocket. Only the legacy
// ?token= path carries a real token_version that still needs gating here.
func wsTokenRevoked(fromTicket bool, claimTokenVersion, userTokenVersion int) bool {
	if fromTicket {
		return false
	}
	return claimTokenVersion < userTokenVersion
}

// wsScopeRejected reports whether a token must be refused at the WebSocket
// upgrade because it carries a scope claim.
//
// Only unscoped access tokens may open a WS. The media-scoped token in the
// hichat_media cookie exists solely to authenticate GET /api/uploads/*; it is
// SameSite=None and therefore comparatively easy to leak, and a WS connection
// is one of the most privileged things on this server — it streams every
// message, DM, and presence event the user can see. Letting a media token
// open one would undo the scoping entirely.
//
// Unknown scopes are rejected as well: fail closed against a token whose
// meaning this binary predates.
//
// The ticket path never reaches this check — it synthesizes claims with no
// scope, and Consume already authenticated the user at mint time.
func wsScopeRejected(scope string) bool {
	return scope != ""
}

// HandleConnection upgrades HTTP to WebSocket, validates auth, and starts the client.
//
// Preferred path: client POSTs /api/auth/ws-ticket, gets a one-time
// 30-second ticket, opens the WS with `?ticket=...`. Tickets are
// consumed on first use and never appear in logs as recoverable
// credentials.
//
// Legacy path: `?token=JWT` (the long-lived access token in the URL).
// Retained during the rollout window so non-upgraded clients keep
// connecting; remove once all official builds are pushing tickets.
func (h *Handler) HandleConnection(w http.ResponseWriter, r *http.Request) {
	claims, fromTicket, ok := h.resolveConnectionAuth(w, r)
	if !ok {
		return
	}

	displayName, avatarURL, dbPrefStatus, ok := h.authorizeUser(w, r, claims, fromTicket)
	if !ok {
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		handlerLogger.Error("websocket upgrade failed", "user_id", claims.UserID, "err", pkg.ErrText(err))
		return
	}

	// pref_status from DB — persistent across devices and sessions
	prefStatus := string(dbPrefStatus)
	if prefStatus == "" {
		prefStatus = "online"
	}

	client := &Client{
		hub:        h.hub,
		conn:       conn,
		userID:     claims.UserID,
		send:       make(chan []byte, sendBufferSize),
		done:       make(chan struct{}),
		prefStatus: prefStatus,
	}
	h.hub.SetUserInfo(claims.UserID, claims.Username, displayName, avatarURL)

	// Set invisible BEFORE register so GetVisibleOnlineUserIDs is correct in the ready event.
	isInvisible := prefStatus == "offline"
	if isInvisible {
		h.hub.SetInvisible(claims.UserID, true)
	}

	// Load user's server list for ready event + BroadcastToServer filtering
	var readyServers []ReadyServerItem
	var serverIDs []string
	if h.serverListProvider != nil {
		if servers, err := h.serverListProvider.GetUserServers(r.Context(), claims.UserID); err == nil {
			readyServers = make([]ReadyServerItem, len(servers))
			serverIDs = make([]string, len(servers))
			for i, s := range servers {
				readyServers[i] = ReadyServerItem{
					ID:      s.ID,
					Name:    s.Name,
					IconURL: s.IconURL,
				}
				serverIDs[i] = s.ID
			}
		}
	}
	client.serverIDs = serverIDs

	// Muted server IDs for notification suppression
	var mutedServerIDs []string
	if h.muteChecker != nil {
		if ids, err := h.muteChecker.GetMutedServerIDs(r.Context(), claims.UserID); err == nil {
			mutedServerIDs = ids
		} else {
			handlerLogger.Error("mute check failed", "user_id", claims.UserID, "err", pkg.ErrText(err))
		}
	}
	if mutedServerIDs == nil {
		mutedServerIDs = []string{}
	}

	// Muted channel IDs for notification suppression
	var mutedChannelIDs []string
	if h.channelMuteChecker != nil {
		if ids, err := h.channelMuteChecker.GetMutedChannelIDs(r.Context(), claims.UserID); err == nil {
			mutedChannelIDs = ids
		} else {
			handlerLogger.Error("channel mute check failed", "user_id", claims.UserID, "err", pkg.ErrText(err))
		}
	}
	if mutedChannelIDs == nil {
		mutedChannelIDs = []string{}
	}

	h.hub.register <- client

	// Send ready event with online users, servers, mute state, and persisted pref_status
	client.sendEvent(Event{
		Op: OpReady,
		Data: ReadyData{
			OnlineUserIDs:   h.hub.GetVisibleOnlineUserIDs(),
			Servers:         readyServers,
			MutedServerIDs:  mutedServerIDs,
			MutedChannelIDs: mutedChannelIDs,
			PrefStatus:      prefStatus,
		},
	})

	h.sendVoiceStatesSync(client, serverIDs)

	// Start pumps — WritePump in goroutine, ReadPump blocks until disconnect.
	// WritePump fans out every hub broadcast to this one connection; wrapped
	// in logx.Go so a panic on one client's write path can't take the whole
	// process down with it (an unrecovered goroutine panic kills every
	// connection, not just this one).
	logx.Go("ws.write_pump", client.WritePump)
	client.ReadPump()
}

// resolveConnectionAuth resolves the caller's identity from either the
// preferred one-shot ticket (?ticket=) or the legacy ?token= path, returning
// the resulting claims. fromTicket reports whether the ticket path produced
// the claims (it carries no token_version / scope). On every reject branch it
// writes the same http.Error + audit log the inline code did and returns
// ok=false; on success it returns the claims with ok=true.
func (h *Handler) resolveConnectionAuth(w http.ResponseWriter, r *http.Request) (claims *models.TokenClaims, fromTicket bool, ok bool) {
	var userIDFromTicket string
	if h.ticketConsumer != nil {
		if t := r.URL.Query().Get("ticket"); t != "" {
			uid, err := h.ticketConsumer.Consume(t)
			if err != nil {
				h.hub.logEvent(models.LogLevelWarn, models.LogCategoryAuth, nil, "WS connect: invalid ticket", map[string]string{
					"error": err.Error(),
				})
				http.Error(w, "invalid ticket", http.StatusUnauthorized)
				return nil, false, false
			}
			userIDFromTicket = uid
		}
	}

	if userIDFromTicket != "" {
		// Ticket exchange already validated the user; synthesize a
		// claims-like shape so the rest of the handler reads the
		// userID uniformly. Username is filled below from
		// userInfoProvider, the same way the JWT path does it.
		claims = &models.TokenClaims{UserID: userIDFromTicket}
	} else {
		// Legacy token path — defaults to REJECT after audit 2026-05-27.
		//
		// JWT in query strings leaks via proxy/CDN logs, browser history,
		// and network monitoring (P0-BC-01). The ticket flow (POST
		// /api/auth/ws-ticket → ?ticket=<one-shot>) replaces it.
		//
		// During the client rollout, operators can opt back in by setting
		// HICHAT_ALLOW_LEGACY_WS_TOKEN=1. Every legacy connection writes
		// an audit event so the operator can track migration progress and
		// remove the env var once usage drops to zero.
		legacyAllowed := os.Getenv("HICHAT_ALLOW_LEGACY_WS_TOKEN") == "1"
		token := r.URL.Query().Get("token")

		if token != "" && !legacyAllowed {
			h.hub.logEvent(models.LogLevelWarn, models.LogCategoryAuth, nil,
				"WS connect blocked: legacy ?token= path rejected (set HICHAT_ALLOW_LEGACY_WS_TOKEN=1 during rollout)",
				map[string]string{
					"remote_addr": r.RemoteAddr,
					"user_agent":  r.Header.Get("User-Agent"),
				})
			http.Error(w, "legacy token path disabled — use /api/auth/ws-ticket", http.StatusUnauthorized)
			return nil, false, false
		}

		if token == "" {
			http.Error(w, "missing ticket", http.StatusUnauthorized)
			return nil, false, false
		}

		// Legacy path explicitly opted-in — validate, but always emit an
		// audit event so operator visibility is unaffected by log level.
		var err error
		claims, err = h.tokenValidator.ValidateAccessToken(token)
		if err != nil {
			h.hub.logEvent(models.LogLevelWarn, models.LogCategoryAuth, nil, "WS connect: invalid token", map[string]string{
				"error": err.Error(),
			})
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return nil, false, false
		}

		// Scope gate — a media cookie must not become a WebSocket session.
		// See wsScopeRejected for the rationale.
		if wsScopeRejected(claims.Scope) {
			h.hub.logEvent(models.LogLevelWarn, models.LogCategoryAuth, &claims.UserID,
				"WS connect blocked: scoped token presented", map[string]string{
					"scope":       claims.Scope,
					"remote_addr": r.RemoteAddr,
				})
			http.Error(w, "token scope not valid for websocket", http.StatusUnauthorized)
			return nil, false, false
		}

		h.hub.logEvent(models.LogLevelInfo, models.LogCategoryAuth, &claims.UserID,
			"WS connect via legacy ?token= path (opted-in via HICHAT_ALLOW_LEGACY_WS_TOKEN)",
			map[string]string{
				"user_agent": r.Header.Get("User-Agent"),
			})
	}

	return claims, userIDFromTicket != "", true
}

// authorizeUser fetches the live user row and applies the pre-upgrade gates —
// token revocation, platform ban, and server-scoped ban — that must pass
// before the connection is upgraded. It also syncs claims.Username from the DB
// row (claims is passed by pointer so the mutation is visible to the caller).
// On each reject branch it writes the same http.Error + audit log the inline
// code did and returns ok=false; on success it returns the DB-derived
// displayName, avatarURL, and pref_status with ok=true.
func (h *Handler) authorizeUser(w http.ResponseWriter, r *http.Request, claims *models.TokenClaims, fromTicket bool) (displayName, avatarURL string, prefStatus models.UserStatus, ok bool) {
	// Fetch user info before upgrade — reject banned users early
	if h.userInfoProvider != nil {
		user, err := h.userInfoProvider.GetByID(r.Context(), claims.UserID)
		if err != nil {
			handlerLogger.Error("user info fetch failed", "user_id", claims.UserID, "err", pkg.ErrText(err))
			h.hub.logEvent(models.LogLevelError, models.LogCategoryWS, &claims.UserID, "WS connect: user lookup failed", map[string]string{
				"error": err.Error(),
			})
			http.Error(w, "user not found", http.StatusUnauthorized)
			return "", "", "", false
		}
		// Token-version (revocation) gate. Previously verified inside
		// AuthService.ValidateAccessToken; moved out so the HTTP
		// middleware can satisfy a request from the userCache. The
		// WS upgrade path doesn't go through that middleware, so we
		// re-check here against the live user row we just fetched
		// (defense-in-depth: a banned/revoked user can't keep a WS
		// open just because their JWT still parses).
		//
		// The ticket path is exempt — see wsTokenRevoked. Its synthesized
		// claims carry no token_version, and the ticket was already gated at
		// mint time; without this exemption every user with a bumped
		// token_version (password change / logout-all / reuse) could log in
		// over HTTP yet never open a WebSocket.
		if wsTokenRevoked(fromTicket, claims.TokenVersion, user.TokenVersion) {
			h.hub.logEvent(models.LogLevelWarn, models.LogCategoryAuth, &claims.UserID, "WS connect blocked: token revoked", nil)
			http.Error(w, "token revoked", http.StatusUnauthorized)
			return "", "", "", false
		}
		if user.IsPlatformBanned {
			h.hub.logEvent(models.LogLevelWarn, models.LogCategoryAuth, &claims.UserID, "WS connect blocked: account suspended", nil)
			http.Error(w, "account suspended", http.StatusForbidden)
			return "", "", "", false
		}
		// Defense in depth against the ticket path (handlers.WSTicket rejects
		// bots at mint time). `HandleConnection` is the *human* gateway; bots
		// have their own read-only route (`GET /api/bot/gateway`,
		// HandleBotConnection), which builds its Client with isBot:true. A bot
		// reaching this function is therefore always wrong — reject rather
		// than propagate isBot, so the connection never exists at all.
		if user.IsBot {
			h.hub.logEvent(models.LogLevelWarn, models.LogCategoryAuth, &claims.UserID, "WS connect blocked: bot on human gateway", nil)
			http.Error(w, "bots must use the bot gateway", http.StatusForbidden)
			return "", "", "", false
		}
		// Always sync username from the live DB row. The ticket path
		// (above) synthesises an empty-Username claims object, and even
		// the JWT path can carry a stale username if the user renamed
		// after the token was issued. Without this, typing/voice WS
		// events broadcast `username: ""` for ticket-connected clients,
		// rendering as blank rows in other members' UIs.
		claims.Username = user.Username
		if user.DisplayName != nil {
			displayName = *user.DisplayName
		}
		if user.AvatarURL != nil {
			avatarURL = *user.AvatarURL
		}
		prefStatus = user.PrefStatus
	}

	// Server-scoped ban check
	if h.banChecker != nil {
		banned, err := h.banChecker.IsBanned(r.Context(), claims.UserID)
		if err != nil {
			handlerLogger.Error("ban check failed", "user_id", claims.UserID, "err", pkg.ErrText(err))
			http.Error(w, "internal error", http.StatusInternalServerError)
			return "", "", "", false
		}
		if banned {
			http.Error(w, "banned", http.StatusForbidden)
			return "", "", "", false
		}
	}

	return displayName, avatarURL, prefStatus, true
}

// sendVoiceStatesSync sends the initial voice-states snapshot so the frontend
// can initialize voiceStore. States are filtered to servers the user belongs
// to — voice events are server-scoped, so leaking states from foreign servers
// would be inconsistent with runtime broadcasts.
func (h *Handler) sendVoiceStatesSync(client *Client, serverIDs []string) {
	if h.voiceStatesProvider != nil {
		userServers := make(map[string]bool, len(serverIDs))
		for _, id := range serverIDs {
			userServers[id] = true
		}

		allStates := h.voiceStatesProvider.GetAllVoiceStates()
		// Snapshot the viewer map once — broadcasters only, others omit it.
		// One map lookup per streamer keeps the wire shape stable for callers
		// that don't care about screen share at all.
		viewersByStreamer := h.voiceStatesProvider.GetAllScreenShareViewers()
		items := make([]VoiceStateItem, 0, len(allStates))
		for _, s := range allStates {
			if !userServers[s.ServerID] {
				continue
			}
			item := VoiceStateItem{
				UserID:           s.UserID,
				ChannelID:        s.ChannelID,
				ServerID:         s.ServerID,
				Username:         s.Username,
				DisplayName:      s.DisplayName,
				AvatarURL:        s.AvatarURL,
				IsMuted:          s.IsMuted,
				IsDeafened:       s.IsDeafened,
				IsStreaming:      s.IsStreaming,
				IsServerMuted:    s.IsServerMuted,
				IsServerDeafened: s.IsServerDeafened,
			}
			if s.IsStreaming {
				if viewers, ok := viewersByStreamer[s.UserID]; ok && len(viewers) > 0 {
					item.ScreenShareViewers = viewers
				}
			}
			items = append(items, item)
		}
		client.sendEvent(Event{
			Op:   OpVoiceStatesSync,
			Data: VoiceStatesSyncData{States: items},
		})
	}
}
