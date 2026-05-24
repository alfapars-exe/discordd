// Package services — shared TLS configuration for outbound LiveKit traffic.
//
// Earlier code embedded `tls.Config{InsecureSkipVerify: true}` directly in
// both the metrics collector and the livekit admin service. That meant
// every platform install — including the managed mqvi.net SaaS, where the
// LiveKit hosts run signed certs — silently ran without server-certificate
// verification. A MITM on the backend↔LiveKit link could lift the API
// secret out of the encrypted JWT payload, observe room metadata, or
// poison metrics. Gosec flagged both occurrences as HIGH (G402).
//
// The fix here keeps verification ON by default and only relaxes it when
// the operator opts in explicitly via the LIVEKIT_INSECURE_TLS env var.
// That preserves the self-host story (turn it on at install time when
// using a self-signed cert) without giving every production deployment
// the same dangerous default.
package services

import (
	"crypto/tls"
	"log"
	"os"
	"strings"
	"sync"
)

const insecureTLSEnv = "LIVEKIT_INSECURE_TLS"

var (
	// Resolved once at process start so the warning log fires exactly once.
	insecureTLSOnce sync.Once
	insecureTLSFlag bool
)

func resolveInsecureTLS() {
	v := strings.TrimSpace(strings.ToLower(os.Getenv(insecureTLSEnv)))
	switch v {
	case "1", "true", "yes", "on":
		insecureTLSFlag = true
		log.Printf("[tls] WARNING: %s=%s — LiveKit TLS verification DISABLED. "+
			"Use only for self-signed certs in a trusted self-hosted setup.",
			insecureTLSEnv, v)
	default:
		insecureTLSFlag = false
	}
}

// liveKitTLSConfig returns the *tls.Config to use when the backend talks
// to a LiveKit instance over HTTPS. Defaults to full server-certificate
// verification; only opts out when the operator sets LIVEKIT_INSECURE_TLS.
func liveKitTLSConfig() *tls.Config {
	insecureTLSOnce.Do(resolveInsecureTLS)
	return &tls.Config{
		// Bind MinVersion so a misconfigured self-host can't fall back to
		// TLS 1.0/1.1 even if their reverse proxy advertises them.
		MinVersion: tls.VersionTLS12,
		// #nosec G402 — InsecureSkipVerify is intentionally controllable
		// at runtime via LIVEKIT_INSECURE_TLS for self-hosters using
		// self-signed certs. Default (env unset) is secure; opting in
		// is a deliberate operator decision logged with a WARNING.
		InsecureSkipVerify: insecureTLSFlag,
	}
}
