package repository

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
)

func TestAppLogBatchFiltersDeletedOwnersAndPreservesCorrelation(t *testing.T) {
	db := newTestDB(t)
	_, err := db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('log-active','logactive','x'),('log-deleted','logdeleted','x')`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Conn.Exec(`UPDATE users SET deleted_at=? WHERE id='log-deleted'`, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	r := NewSQLiteAppLogRepo(wrapForRepo(db)).(*sqliteAppLogRepo)
	active, deleted := "log-active", "log-deleted"
	stamp := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	base := models.AppLog{Level: models.LogLevelError, Category: models.LogCategoryGeneral, Message: "failed", Metadata: `{"detail":"retained"}`, CreatedAt: stamp, LastSeenAt: stamp, RequestID: "request-42", EventCode: "TEST_ERROR", Component: "test", ErrorKind: "database", OccurrenceCount: 3}
	a, b, c := base, base, base
	a.UserID = &active
	b.UserID = &deleted
	c.RequestID = "request-other"
	written, err := r.InsertBatch(context.Background(), []models.AppLog{a, b, c})
	if err != nil {
		t.Fatal(err)
	}
	if written != 2 {
		t.Fatalf("written=%d", written)
	}
	rows, total, err := r.List(context.Background(), models.AppLogFilter{RequestID: "request-42", Component: "test", EventCode: "TEST_ERROR", From: time.Now().Add(-2 * time.Hour).UTC().Format(time.RFC3339), To: time.Now().UTC().Format(time.RFC3339)})
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(rows) != 1 || rows[0].OccurrenceCount != 3 || rows[0].UserID == nil || *rows[0].UserID != active {
		t.Fatalf("wrong filtered rows: %+v total=%d", rows, total)
	}
	if _, err = db.Conn.Exec(`INSERT INTO app_logs(user_id,message)VALUES('log-deleted','must reject')`); err == nil {
		t.Fatal("deleted-account trigger was weakened")
	}
}

func TestAppLogPurgeOnlyDeletesExpiredRowsInBoundedBatches(t *testing.T) {
	db := newTestDB(t)
	r := NewSQLiteAppLogRepo(db.Conn).(*sqliteAppLogRepo)
	for _, age := range []int{-8, -6} {
		stamp := time.Now().AddDate(0, 0, age).UTC().Format(time.RFC3339)
		_, err := r.InsertBatch(context.Background(), []models.AppLog{{Level: models.LogLevelWarn, Category: models.LogCategoryGeneral, Message: fmt.Sprint(age), Metadata: "{}", CreatedAt: stamp}})
		if err != nil {
			t.Fatal(err)
		}
	}
	n, err := r.DeleteBefore(context.Background(), time.Now().AddDate(0, 0, -7).UTC().Format("2006-01-02 15:04:05"))
	if err != nil || n != 1 {
		t.Fatalf("purged=%d err=%v", n, err)
	}
	rows, total, err := r.List(context.Background(), models.AppLogFilter{})
	if err != nil || total != 1 || rows[0].Message != "-6" {
		t.Fatalf("rows=%+v total=%d err=%v", rows, total, err)
	}
}

func TestRuntimeTelemetryDiagnosticsSurviveInsertAndUpsert(t *testing.T) {
	db := newTestDB(t)
	repo := NewSQLiteRuntimeTelemetryRepo(db.Conn)
	row := &models.RuntimeTelemetry{BucketAt: time.Now().UTC().Truncate(time.Minute).Format("2006-01-02 15:04:05"), Diagnostics: `{"db_max_open":4,"db_wait_duration_ms_delta":10}`}
	if err := repo.Insert(context.Background(), row); err != nil {
		t.Fatal(err)
	}
	row.Diagnostics = `{"db_max_open":4,"db_wait_duration_ms_delta":20}`
	if err := repo.Insert(context.Background(), row); err != nil {
		t.Fatal(err)
	}
	var got string
	if err := db.Conn.QueryRow(`SELECT diagnostics FROM runtime_telemetry WHERE bucket_at=?`, row.BucketAt).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != row.Diagnostics {
		t.Fatalf("diagnostics lost on upsert: %s", got)
	}
}

func BenchmarkAppLogWrites(b *testing.B) {
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError})))
	defer slog.SetDefault(previous)
	for _, size := range []int{1, 64} {
		b.Run(fmt.Sprintf("batch_%d", size), func(b *testing.B) {
			db := newTestDB(b)
			r := NewSQLiteAppLogRepo(db.Conn).(*sqliteAppLogRepo)
			rows := make([]models.AppLog, size)
			for i := range rows {
				rows[i] = models.AppLog{Level: models.LogLevelError, Category: models.LogCategoryGeneral, Message: "benchmark", Metadata: "{}"}
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := r.InsertBatch(context.Background(), rows); err != nil {
					b.Fatal(err)
				}
			}
			b.ReportMetric(float64(b.Elapsed().Nanoseconds())/float64(b.N*size), "ns/event")
		})
	}
}
