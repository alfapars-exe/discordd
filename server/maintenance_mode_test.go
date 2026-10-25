package main

import (
	"net/http/httptest"
	"testing"
)

func TestMaintenanceBlocksReadsAndWritesExceptLiveness(t *testing.T) {
	for _, tc := range []struct {
		method, path string
		status       int
	}{{"GET", "/api/health", 200}, {"GET", "/api/ready", 503}, {"GET", "/api/users/me", 503}, {"POST", "/api/auth/register", 503}, {"POST", "/api/servers", 503}, {"GET", "/ws", 503}} {
		w := httptest.NewRecorder()
		maintenanceHandler(w, httptest.NewRequest(tc.method, tc.path, nil))
		if w.Code != tc.status {
			t.Fatalf("%s %s: %d", tc.method, tc.path, w.Code)
		}
		if tc.status == 503 && w.Header().Get("Retry-After") == "" {
			t.Fatal("missing maintenance retry header")
		}
	}
}
