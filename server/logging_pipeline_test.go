package main

import (
	"context"
	"errors"
	"io/fs"
	"log"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/config"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/middleware"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/logx"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
)

func TestBackendFailureReachesPersistentAdminLogsExactlyOnce(t *testing.T) {
	previous, oldWriter, oldFlags := slog.Default(), log.Writer(), log.Flags()
	logx.Init(config.LoggingConfig{Level: "error", Format: "json"})
	t.Cleanup(func() {
		logx.SetAppSink(nil)
		slog.SetDefault(previous)
		log.SetOutput(oldWriter)
		log.SetFlags(oldFlags)
	})
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.NewLegacy(filepath.Join(t.TempDir(), "logs.db"), migrations)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	svc := services.NewAppLogService(repository.NewSQLiteAppLogRepo(db.Conn))
	svc.Start()
	defer svc.Stop()
	sink := svc.(interface {
		ConsumeRecord(context.Context, slog.Record)
	})
	logx.SetAppSink(sink.ConsumeRecord)
	defer logx.SetAppSink(nil)
	h := middleware.RequestLogger(slog.Default(), nil)(middleware.Recover(slog.Default())(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pkg.ErrorCtx(r.Context(), w, 500, "failed", errors.New("postgres://user:NEVER_LOG@host/database failed token=NEVER_LOG"))
	})))
	req := httptest.NewRequest("POST", "/fail", nil)
	req.Header.Set("X-Request-Id", "integration-request")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 500 || !strings.Contains(w.Body.String(), "integration-request") {
		t.Fatalf("response=%d %s", w.Code, w.Body.String())
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		rows, total, err := svc.List(context.Background(), models.AppLogFilter{RequestID: "integration-request"})
		if err != nil {
			t.Fatal(err)
		}
		if total > 0 {
			if total != 1 || len(rows) != 1 || rows[0].Level != models.LogLevelError || rows[0].EventCode != "HTTP_INTERNAL" {
				t.Fatalf("wrong events: %+v total=%d", rows, total)
			}
			if strings.Contains(rows[0].Metadata, "NEVER_LOG") {
				t.Fatal("persistent sink leaked credential")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("backend failure never reached admin log storage")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestRouteLatencyHistogramsHaveBoundedCardinalityAndExactCounts(t *testing.T) {
	a := &httpStatsAggregator{}
	for i := 0; i < 1000; i++ {
		a.ObserveRequest("GET /api/version", 200, 30*time.Millisecond)
	}
	for i := 0; i < 10; i++ {
		a.ObserveRequest("GET /api/link-preview", 502, 3*time.Second)
	}
	requests, failures, _, _, routes := a.snapshotWindow()
	if requests != 1010 || failures != 10 {
		t.Fatalf("requests=%d failures=%d", requests, failures)
	}
	preview := routes["GET /api/link-preview"].(map[string]any)
	if preview["p95_ms_upper"] != int64(5000) {
		t.Fatal(preview)
	}
	for i := 0; i < 1000; i++ {
		a.ObserveRequest(strings.Repeat("x", i+1), 200, time.Millisecond)
	}
	if len(a.routes) > 513 {
		t.Fatalf("unbounded keys: %d", len(a.routes))
	}
	_, _, _, _, routes = a.snapshotWindow()
	if len(routes) > 33 {
		t.Fatal("oversized persisted route summary")
	}
	var count int64
	for _, value := range routes {
		count += value.(map[string]any)["requests"].(int64)
	}
	if count != 1000 {
		t.Fatalf("route overflow lost observations: %d", count)
	}
}
