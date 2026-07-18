//go:build !windows

// go-libsql is a CGO-based driver for remote libSQL/Turso. On Windows the
// build fails without a C toolchain; production Linux builds still get
// the driver via this file. Local SQLite (modernc.org/sqlite) is
// imported in database.go and works everywhere without CGO.
package database

import (
	_ "github.com/tursodatabase/go-libsql" // registers "libsql"
)
