package main

import (
	"net/http"

	"github.com/argeinfina/hichat/handlers"
	"github.com/argeinfina/hichat/middleware"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
)

// routeRegistrar is the subset of *http.ServeMux that initRoutes needs.
// Taking it as an interface (rather than the concrete *http.ServeMux) lets
// tests inject a recording registrar that snapshots the exact ordered set of
// registered patterns — the golden route-set net (see init_routes_test.go)
// that guards these registrations against accidental drift when the body is
// split into per-domain helpers. *http.ServeMux satisfies it, so the main.go
// call site is unchanged.
type routeRegistrar interface {
	Handle(pattern string, handler http.Handler)
	HandleFunc(pattern string, handler func(http.ResponseWriter, *http.Request))
}

// routeDeps bundles everything the per-domain route registrars need: the mux,
// the handler set, the constructed middlewares and the once-constructed bot
// handler. The middleware-chain helpers (auth / authServer / authServerPerm /
// authServerPermLoad / authAdmin / deviceEnum) are methods on *routeDeps so
// every domain group can call d.auth(…) etc. against the same middleware
// instances without re-plumbing them.
type routeDeps struct {
	mux             routeRegistrar
	h               *Handlers
	authMw          *middleware.AuthMiddleware
	permMw          *middleware.PermissionMiddleware
	serverMw        *middleware.ServerMembershipMiddleware
	platformAdminMw *middleware.PlatformAdminMiddleware

	// deviceEnumMw is the per-IP throttle for public E2EE key-material
	// enumeration (P0-BD-02): caps GET /api/users/{id}/devices and
	// .../prekey-bundles.
	deviceEnumMw func(http.Handler) http.Handler

	// refreshMw is the per-IP throttle for POST /api/auth/refresh (resource
	// scan 2026-07-31, finding N-14): the endpoint has no auth middleware
	// (it hands out the auth) and previously had no rate limit at all.
	refreshMw func(http.Handler) http.Handler

	botHandler *handlers.BotHandler
}

// Middleware chain helpers.
func (d *routeDeps) auth(handler http.HandlerFunc) http.Handler {
	return d.authMw.Require(http.HandlerFunc(handler))
}

func (d *routeDeps) authServer(handler http.HandlerFunc) http.Handler {
	return d.authMw.Require(d.serverMw.Require(http.HandlerFunc(handler)))
}

func (d *routeDeps) authServerPerm(perm models.Permission, handler http.HandlerFunc) http.Handler {
	return d.authMw.Require(d.serverMw.Require(d.permMw.Require(perm, http.HandlerFunc(handler))))
}

func (d *routeDeps) authServerPermLoad(handler http.HandlerFunc) http.Handler {
	return d.authMw.Require(d.serverMw.Require(d.permMw.Load(http.HandlerFunc(handler))))
}

func (d *routeDeps) authAdmin(handler http.HandlerFunc) http.Handler {
	return d.authMw.Require(d.platformAdminMw.Require(http.HandlerFunc(handler)))
}

func (d *routeDeps) deviceEnum(handler http.Handler) http.Handler {
	return d.deviceEnumMw(handler)
}

func (d *routeDeps) refresh(handler http.HandlerFunc) http.Handler {
	return d.refreshMw(handler)
}

// initRoutes registers all API endpoints.
// Literal paths must be registered before parametric ones
// (e.g. "/api/servers/join" before "/api/servers/{serverId}").
//
// Returns the constructed AuthMiddleware and PermissionMiddleware so
// main.go can wire their cache invalidators into the services that mutate
// the data those caches memoize: AuthMiddleware's user cache into the admin
// user service (ban / delete / admin-change → immediate HTTP enforcement
// instead of waiting out the cache TTL), and PermissionMiddleware's
// per-server permission cache into role/member services (role-perm edit /
// kick / ban / role-reassign → immediate invalidation instead of the 5s
// TTL).
func initRoutes(
	mux routeRegistrar,
	h *Handlers,
	authService services.AuthService,
	userRepo repository.UserRepository,
	roleRepo repository.RoleRepository,
	serverRepo repository.ServerRepository,
	deviceEnumLimiter middleware.IPRateLimiter,
	refreshLimiter middleware.IPRateLimiter,
	botService *services.BotService,
) (*middleware.AuthMiddleware, *middleware.PermissionMiddleware) {
	// Middleware. *services.BotService satisfies middleware.BotTokenValidator
	// (ValidateBotToken), so the same instance powers token validation here and
	// the owner-facing bot management handler below — one source of truth.
	authMw := middleware.NewAuthMiddleware(authService, userRepo, botService)
	permMw := middleware.NewPermissionMiddleware(roleRepo)
	serverMw := middleware.NewServerMembershipMiddleware(serverRepo)
	platformAdminMw := middleware.NewPlatformAdminMiddleware()

	// Bot handler constructed once. The same botService that backs bot-token
	// validation in the auth middleware also serves the owner-facing management
	// handler wired into registerBotRoutes — one source of truth.
	botHandler := handlers.NewBotHandler(botService)

	d := &routeDeps{
		mux:             mux,
		h:               h,
		authMw:          authMw,
		permMw:          permMw,
		serverMw:        serverMw,
		platformAdminMw: platformAdminMw,
		// Per-IP throttle for public E2EE key-material enumeration (P0-BD-02):
		// caps GET /api/users/{id}/devices and .../prekey-bundles.
		deviceEnumMw: middleware.RateLimitByIP(deviceEnumLimiter),
		// Per-IP throttle for POST /api/auth/refresh (resource scan
		// 2026-07-31, finding N-14): see refreshMw's field doc.
		refreshMw:  middleware.RateLimitByIP(refreshLimiter),
		botHandler: botHandler,
	}

	// ╔══════════════════════════════════════════╗
	// ║  GLOBAL ROUTES (server-independent)       ║
	// ╚══════════════════════════════════════════╝
	d.registerAuthRoutes()
	d.registerUserRoutes()
	d.registerServerListRoutes()
	d.registerUploadRoutes()
	d.registerDMRoutes()
	d.registerBlockReportRoutes()
	d.registerDiagnosticsRoutes()
	d.registerFeedbackRoutes()
	d.registerE2EERoutes()
	d.registerMiscGlobalRoutes()
	d.registerBadgeRoutes()
	d.registerGifRoutes()
	d.registerFriendRoutes()
	d.registerBotRoutes()
	d.registerAdminRoutes()
	d.registerPublicRoutes()

	// ╔══════════════════════════════════════════╗
	// ║  SERVER-SCOPED ROUTES                     ║
	// ╚══════════════════════════════════════════╝
	d.registerServerRoutes()
	d.registerChannelRoutes()
	d.registerMessageRoutes()
	d.registerMemberRoutes()
	d.registerRoleRoutes()
	d.registerServerMiscRoutes()
	d.registerVoiceMusicRoutes()
	d.registerSoundboardRoutes()
	d.registerWSRoutes()

	return authMw, permMw
}
