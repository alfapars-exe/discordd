package handlers

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
)

func TestClientErrorReserveSurvivesInfoBurstAndIdleBucketsExpire(t *testing.T) {
	h := NewClientLogHandler(&capturingAppLog{})
	for i := 0; i < clientLogPerUserBurst; i++ {
		if !h.allowLevel("user", false) {
			t.Fatal("ordinary burst rejected")
		}
	}
	if h.allowLevel("user", false) {
		t.Fatal("INFO exceeded shared bucket")
	}
	for i := 0; i < 5; i++ {
		if !h.allowLevel("user", true) {
			t.Fatal("ERROR reserve was exhausted by INFO")
		}
	}
	if h.allowLevel("user", true) {
		t.Fatal("ERROR reserve unbounded")
	}
	h.buckets["stale"] = &clientLogBucket{seen: time.Now().Add(-time.Hour)}
	h.lastPurge = time.Time{}
	_ = h.allowLevel("new-user", false)
	if _, exists := h.buckets["stale"]; exists {
		t.Fatal("idle bucket retained")
	}
}

func TestMusicDeadlineKeepsExistingNetworkCodeAndUses504(t *testing.T) {
	r := httptest.NewRequest("POST", "/music/play", nil)
	w := httptest.NewRecorder()
	if !musicFailure(w, r, errors.Join(errors.New("extraction failed"), context.DeadlineExceeded), "play") {
		t.Fatal("deadline not classified")
	}
	if w.Code != 504 || !strings.Contains(w.Body.String(), "MUSIC_NETWORK") {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w = httptest.NewRecorder()
	if !musicFailure(w, r.WithContext(ctx), context.Canceled, "play") || w.Body.Len() != 0 {
		t.Fatal("canceled caller received server failure")
	}
}

type failedPreviewService struct{ err error }

func (s failedPreviewService) GetPreview(context.Context, string) (*models.LinkPreview, error) {
	return nil, s.err
}

func TestLogAdminRejectsInvalidDateBeforeQuery(t *testing.T) {
	h := &AdminHandler{appLogService: &capturingAppLog{}}
	w := httptest.NewRecorder()
	h.ListAppLogs(w, httptest.NewRequest("GET", "/api/admin/logs?from=invalid", nil))
	if w.Code != 400 {
		t.Fatalf("status=%d", w.Code)
	}
}
