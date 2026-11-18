package repository

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

// Repository operation timings, not HTTP percentiles or concurrent pool budgets.
// Use -benchtime=30x -count=9 for repeated measurements of each population.
func BenchmarkGroupPublicProfilePopulation(b *testing.B) {
	db := newTestDB(b)
	ctx := context.Background()
	ids := seedProfileBenchmark(b, db, ctx)
	repo := NewSQLiteUserRepo(db.Conn)
	for _, size := range []int{0, 1, 100, 1001} {
		page := ids[:size]
		checkProfileBenchmarkParity(b, repo, ctx, page, size)
		for _, bulk := range []bool{false, true} {
			b.Run(fmt.Sprintf("users=%d/bulk=%t", size, bulk), func(b *testing.B) {
				runProfilePopulationBenchmark(b, db, repo, ctx, page, size, bulk)
			})
		}
	}
}

func seedProfileBenchmark(b *testing.B, db *database.DB, ctx context.Context) []string {
	tx, err := db.Conn.BeginTx(ctx, nil)
	if err != nil {
		b.Fatal(err)
	}
	defer tx.Rollback()
	ids := make([]string, 1001)
	for i := range ids {
		ids[i] = fmt.Sprintf("profile-bench-%04d", i)
		if _, err := tx.ExecContext(ctx, `INSERT INTO users(id,username,password_hash) VALUES(?,?,?)`, ids[i], ids[i], "private-fixture-hash"); err != nil {
			b.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		b.Fatal(err)
	}
	return ids
}

func checkProfileBenchmarkParity(b *testing.B, repo UserRepository, ctx context.Context, page []string, size int) {
	found, err := repo.PublicUsersByID(ctx, page)
	if err != nil || len(found) != size {
		b.Fatalf("bulk parity size=%d: %v", size, err)
	}
	for _, id := range page {
		user, err := repo.GetByID(ctx, id)
		if err != nil || !reflect.DeepEqual(found[id], models.ToPublicUser(user)) {
			b.Fatalf("projection differs: %v", err)
		}
	}
}

func runProfilePopulationBenchmark(b *testing.B, db *database.DB, repo UserRepository, ctx context.Context, page []string, size int, bulk bool) {
	measureLatency := os.Getenv("HICHAT_PROFILE_LATENCY") == "1"
	if measureLatency && b.N > 10000 {
		b.Fatal("Latency sampling requires fixed -benchtime up to10000 operations")
	}
	var samples []time.Duration
	if measureLatency {
		samples = make([]time.Duration, b.N)
	}
	before := db.Conn.Stats()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		started := time.Time{}
		if measureLatency {
			started = time.Now()
		}
		readProfilePopulation(b, repo, ctx, page, size, bulk)
		if measureLatency {
			samples[i] = time.Since(started)
		}
	}
	b.StopTimer()
	if measureLatency {
		b.Logf("operationLatenciesNs=%d", samples)
		p50, p95 := profileLatencyPercentiles(samples)
		b.ReportMetric(float64(p50.Nanoseconds()), "p50-ns/op")
		b.ReportMetric(float64(p95.Nanoseconds()), "p95-ns/op")
	}
	after := db.Conn.Stats()
	b.ReportMetric(float64((after.WaitDuration-before.WaitDuration).Nanoseconds())/float64(b.N), "pool-wait-ns/op")
}

func readProfilePopulation(b *testing.B, repo UserRepository, ctx context.Context, page []string, size int, bulk bool) {
	if bulk {
		result, err := repo.PublicUsersByID(ctx, page)
		if err != nil || len(result) != size {
			b.Fatalf("bulk rows=%d: %v", len(result), err)
		}
	} else {
		for _, id := range page {
			if _, err := repo.GetByID(ctx, id); err != nil {
				b.Fatal(err)
			}
		}
	}
}

// Nearest ranks of complete operation durations; call only with nonempty samples.
func profileLatencyPercentiles(samples []time.Duration) (time.Duration, time.Duration) {
	slices.Sort(samples)
	return samples[(len(samples)*50+99)/100-1], samples[(len(samples)*95+99)/100-1]
}

func TestProfileLatencyNearestRanks(t *testing.T) {
	for _, n := range []int{1, 2, 30} {
		samples := make([]time.Duration, n)
		for i := range samples {
			samples[i] = time.Duration(n - i)
		}
		p50, p95 := profileLatencyPercentiles(samples)
		if p50 != time.Duration((n*50+99)/100) || p95 != time.Duration((n*95+99)/100) {
			t.Fatalf("n=%d ranks=%v/%v", n, p50, p95)
		}
	}
}
