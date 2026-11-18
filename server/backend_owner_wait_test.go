package main

import (
	"testing"
	"time"
)

func TestBackendOwnerWait(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want time.Duration
	}{
		{"", defaultBackendOwnerWait},
		{"45s", 45 * time.Second},
		{"0", 0},
		{"not-a-duration", defaultBackendOwnerWait},
		{"-1s", defaultBackendOwnerWait},
		{"2h", defaultBackendOwnerWait},
	} {
		t.Setenv("HICHAT_BACKEND_OWNER_WAIT", tc.raw)
		if got := backendOwnerWait(); got != tc.want {
			t.Errorf("HICHAT_BACKEND_OWNER_WAIT=%q: got %s, want %s", tc.raw, got, tc.want)
		}
	}
}
