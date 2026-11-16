package repository

import (
	"context"
	"fmt"
	"reflect"
	"testing"

	"github.com/argeinfina/hichat/models"
)

// Repository operation timings, not HTTP percentiles or concurrent pool budgets.
// Use -benchtime=30x -count=9 for repeated measurements of each population.
func BenchmarkGroupPublicProfilePopulation(b *testing.B) {
	db := newTestDB(b)
	ctx := context.Background()
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
	repo := NewSQLiteUserRepo(db.Conn)
	for _, size := range []int{0, 1, 100, 1001} {
		page := ids[:size]
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
		for _, bulk := range []bool{false, true} {
			b.Run(fmt.Sprintf("users=%d/bulk=%t", size, bulk), func(b *testing.B) {
				before := db.Conn.Stats()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
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
				b.StopTimer()
				after := db.Conn.Stats()
				b.ReportMetric(float64((after.WaitDuration-before.WaitDuration).Nanoseconds())/float64(b.N), "pool-wait-ns/op")
			})
		}
	}
}
