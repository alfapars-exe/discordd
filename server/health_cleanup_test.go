package main

import (
	"github.com/argeinfina/hichat/services"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHealthHandlerAccountCleanupNeverFakesSuccess(t *testing.T) {
	now := time.Now()
	stale := now.Add(-4 * time.Minute)
	for _, tt := range []struct {
		name  string
		state services.AccountAssetCleanupStatus
		want  string
	}{
		{"not checked", services.AccountAssetCleanupStatus{Running: true}, "degraded"},
		{"checked healthy", services.AccountAssetCleanupStatus{Running: true, LastCheckedAt: &now, LastSuccessAt: &now}, "ok"},
		{"failed", services.AccountAssetCleanupStatus{Running: true, LastCheckedAt: &now, ConsecutiveFailures: 1}, "degraded"},
		{"stale", services.AccountAssetCleanupStatus{Running: true, LastCheckedAt: &stale}, "degraded"},
		{"stopped", services.AccountAssetCleanupStatus{LastCheckedAt: &now}, "degraded"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			cache := &readinessCache{}
			cache.store(readinessSnapshot{Ready: true, DBOK: true, CheckedAt: now})
			rec := httptest.NewRecorder()
			healthHandler(cache, func() services.AccountAssetCleanupStatus { return tt.state })(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
			if rec.Code != 200 {
				t.Fatal("cleanup degraded liveness status", rec.Code)
			}
			body := decodeHealthBody(t, rec)
			if body["status"] != tt.want {
				t.Fatalf("status %v want %s", body["status"], tt.want)
			}
			checks := body["checks"].(map[string]any)
			if _, ok := checks["account_asset_cleanup"]; !ok {
				t.Fatal("cleanup health omitted")
			}
		})
	}
}
