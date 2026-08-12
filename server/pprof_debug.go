package main

import (
	"net/http"
	"net/http/pprof"
	"os"

	"github.com/argeinfina/hichat/middleware"
)

// Env-gated pprof (P3.12). Off by default: HICHAT_PPROF must be exactly "1"
// for the routes to be registered at all — when unset/anything else, this
// function does nothing and /debug/pprof/* simply doesn't exist on the mux.
//
// Registered on our own mux (routeRegistrar / *http.ServeMux), never on
// net/http's DefaultServeMux: relying on the default mux is the well-known
// pprof footgun — importing net/http/pprof anywhere in the binary registers
// its handlers there unconditionally, and if anything in this process (or a
// dependency) ever serves DefaultServeMux directly, /debug/pprof/* becomes
// reachable with no gate at all, env or otherwise. Every handler this file
// registers is instead threaded through the same double gate (auth +
// platform-admin) applied explicitly below.
//
// Deliberately NOT wired into initRoutes: that function's registrations are
// covered by the golden route-set test (init_routes_test.go), and pprof is
// conditional infra, not a stable API surface — adding it there would make
// every HICHAT_PPROF=1 deployment fail that test. Registered directly on
// mux instead, the same way health.go's /api/health and /api/ready are.
func registerPprofRoutes(mux *http.ServeMux, authMw *middleware.AuthMiddleware) {
	if os.Getenv("HICHAT_PPROF") != "1" {
		return
	}

	// Double gate: authMw.Require checks the caller is an authenticated
	// user; PlatformAdminMiddleware.Require then checks that user is a
	// platform admin. Same composition as routeDeps.authAdmin
	// (init_routes.go) — pprof exposes goroutine stacks, heap contents and
	// full-process CPU/execution traces, which is at least as sensitive as
	// anything gated authAdmin today.
	gate := func(h http.HandlerFunc) http.Handler {
		return authMw.Require(middleware.NewPlatformAdminMiddleware().Require(h))
	}

	mux.Handle("GET /debug/pprof/", gate(pprof.Index))
	mux.Handle("GET /debug/pprof/cmdline", gate(pprof.Cmdline))
	mux.Handle("GET /debug/pprof/profile", gate(pprof.Profile))
	mux.Handle("GET /debug/pprof/symbol", gate(pprof.Symbol))
	mux.Handle("POST /debug/pprof/symbol", gate(pprof.Symbol))
	mux.Handle("GET /debug/pprof/trace", gate(pprof.Trace))

	for _, name := range []string{"heap", "goroutine", "allocs", "block", "mutex"} {
		mux.Handle("GET /debug/pprof/"+name, gate(pprof.Handler(name).ServeHTTP))
	}

	bootLogger.Warn("pprof debug endpoints enabled (HICHAT_PPROF=1) — gated behind platform-admin auth")
}
