package services

import (
	"context"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"os"
	"sort"
	"sync"
	"testing"
	"time"
)

// Opt-in local comparison; production defaults are never changed by this test.
func TestChannelDeliveryPoolComparison(t *testing.T) {
	if os.Getenv("HICHAT_POOL_COMPARISON") != "1" {
		t.Skip("opt-in pool comparison")
	}
	for round := 0; round < 3; round++ {
		for _, size := range []int{4, 6, 8} {
			t.Run(fmt.Sprintf("round%d/pool%d", round, size), func(t *testing.T) {
				s, db, _, _ := channelDeliveryFixture(t)
				db.SetMaxOpenConns(size)
				db.SetMaxIdleConns(size - 1)
				owner, err := db.Conn(context.Background())
				if err != nil {
					t.Fatal(err)
				}
				defer owner.Close()
				stop := StartChannelDelivery(context.Background(), s)
				defer stop()
				samples := make(chan time.Duration, 120)
				failures := make(chan error, 120)
				var wg sync.WaitGroup
				for worker := 0; worker < 6; worker++ {
					wg.Add(1)
					go func(worker int) {
						defer wg.Done()
						for i := 0; i < 20; i++ {
							start := time.Now()
							_, err := s.Create(context.Background(), "default", "channel", "sender", &models.CreateMessageRequest{Content: "pool measurement", ClientMessageID: fmt.Sprintf("%d-%d", worker, i)})
							if err != nil {
								failures <- err
							} else {
								samples <- time.Since(start)
							}
						}
					}(worker)
				}
				wg.Wait()
				close(samples)
				close(failures)
				for err := range failures {
					t.Error(err)
				}
				var values []time.Duration
				for sample := range samples {
					values = append(values, sample)
				}
				sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
				if len(values) != 120 {
					t.Fatalf("completed %d/120", len(values))
				}
				stats := db.Stats()
				deadline := time.Now().Add(20 * time.Second)
				for {
					health, err := s.ChannelDeliveryHealth(context.Background())
					if err != nil {
						t.Fatal(err)
					}
					if health.Pending == 0 {
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("outbox did not drain")
					}
					time.Sleep(10 * time.Millisecond)
				}
				t.Logf("pool=%d samples=%d p95_ms=%.3f p99_ms=%.3f waits=%d wait_ms=%.3f", size, len(values), float64(values[113].Microseconds())/1000, float64(values[118].Microseconds())/1000, stats.WaitCount, float64(stats.WaitDuration.Microseconds())/1000)
			})
		}
	}
}
