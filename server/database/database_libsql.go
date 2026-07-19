//go:build !windows && cgo

// go-libsql is a CGO-based driver for remote libSQL/Turso. Production Linux
// builds get it via this file; local SQLite (modernc.org/sqlite) is imported
// in database.go and works everywhere without CGO.
//
// The constraint needs BOTH terms. `!windows` alone was not enough: with
// CGO_ENABLED=0 on Linux this file was still compiled, and go-libsql's own
// files are all cgo-gated, so the build died with "build constraints exclude
// all Go files in .../go-libsql" — a hard error, not the warning that
// server/Dockerfile's comment claimed. That broke every pure-Go Linux build:
// the docker-compose / self-host image (server/Dockerfile builds with
// CGO_ENABLED=0) and the Playwright E2E suite, which builds the server the
// same way so developers and CI run an identical binary. Adding `cgo` makes
// the exclusion happen here, where it is intended and documented, instead of
// failing inside a dependency.
package database

import (
	_ "github.com/tursodatabase/go-libsql" // registers "libsql"
)
