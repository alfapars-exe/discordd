package handlers

import (
	"github.com/argeinfina/hichat/testutil"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGameJoinHTTPFixturesReleaseLimiterWorkers(t *testing.T) {
	before := handlerLimiterWorkers(t)
	t.Run("admission", TestGameJoinHTTPAdmission)
	t.Run("late_session_revocation", TestGameJoinTargetsRecheckSessionBeforeResponse)
	testutil.AssertWorkerCount(t, before, func() int { return handlerLimiterWorkers(t) })
}

func TestGameJoinUsesInjectedLimiterWithoutCreatingWorkers(t *testing.T) {
	limiter := newGameJoinTestLimiter(t)
	before := handlerLimiterWorkers(t)
	first := NewGameJoinHandler(nil, nil, nil, nil, limiter)
	second := NewGameJoinHandler(nil, nil, nil, nil, limiter)
	missing := NewGameJoinHandler(nil, nil, nil, nil, nil)
	if after := handlerLimiterWorkers(t); after != before {
		t.Fatalf("handler constructor spawned workers: before=%d after=%d", before, after)
	}
	for i := 0; i < 60; i++ {
		handler := first
		if i%2 == 1 {
			handler = second
		}
		if !handler.allow(httptest.NewRecorder(), "viewer") {
			t.Fatalf("shared budget rejected request %d", i+1)
		}
	}
	for _, handler := range []*GameJoinHandler{first, second, missing} {
		response := httptest.NewRecorder()
		if handler.allow(response, "viewer") || response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") != "60" {
			t.Fatalf("missing/exhausted limiter did not fail closed: status=%d retry=%q", response.Code, response.Header().Get("Retry-After"))
		}
	}
	limiter.Stop()
	if first.allow(httptest.NewRecorder(), "viewer") {
		t.Fatal("shutdown reset the shared budget")
	}
}
