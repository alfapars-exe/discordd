package main

import (
	"os"
	"strings"
	"time"
)

// defaultBackendOwnerWait covers an overlapping restart and the server-side
// idle limit that reaps an owner session whose process died uncleanly.
const defaultBackendOwnerWait = 3 * time.Minute

// backendOwnerWait reads HICHAT_BACKEND_OWNER_WAIT (Go duration, 0..30m). An
// unusable value falls back to the default instead of blocking boot.
func backendOwnerWait() time.Duration {
	raw := strings.TrimSpace(os.Getenv("HICHAT_BACKEND_OWNER_WAIT"))
	if raw == "" {
		return defaultBackendOwnerWait
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d < 0 || d > 30*time.Minute {
		bootLogger.Warn("invalid HICHAT_BACKEND_OWNER_WAIT; using default", "default", defaultBackendOwnerWait.String())
		return defaultBackendOwnerWait
	}
	return d
}
