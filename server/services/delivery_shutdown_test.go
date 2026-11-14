package services

import (
	"bytes"
	"context"
	"database/sql"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestDeliveryStopCancelsPoolWait(t *testing.T) {
	for _, kind := range []string{"channel", "dm"} {
		t.Run(kind, func(t *testing.T) {
			var db *sql.DB
			var stop func()
			if kind == "channel" {
				s, pool, _, _ := channelDeliveryFixture(t)
				db = pool
				stop = StartChannelDelivery(context.Background(), s)
			} else {
				s, pool, _, _ := dmOutboxFixture(t)
				db = pool
				var err error
				stop, err = StartDMDelivery(context.Background(), s)
				if err != nil {
					t.Fatal(err)
				}
			}
			t.Cleanup(stop)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			held, err := db.Conn(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer held.Close()
			before := db.Stats().WaitCount
			db.SetMaxOpenConns(1)
			deadline := time.Now().Add(3 * time.Second)
			for db.Stats().WaitCount <= before {
				if time.Now().After(deadline) {
					t.Fatal("delivery worker never waited on saturated pool")
				}
				time.Sleep(time.Millisecond)
			}
			done := make(chan struct{})
			go func() { stop(); close(done) }()
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				t.Fatal("Stop failed to cancel and join pool-blocked delivery")
			}
			if err := held.PingContext(ctx); err != nil {
				t.Fatalf("Stop invalidated caller-owned connection: %v", err)
			}
			stop()
		})
	}
}

func TestDeliveryClaimCancellationLogging(t *testing.T) {
	for _, kind := range []string{"channel", "dm"} {
		t.Run(kind, func(t *testing.T) {
			var output bytes.Buffer
			logger := slog.New(slog.NewTextHandler(&output, nil))
			var claim func(context.Context) bool
			var db *sql.DB
			if kind == "channel" {
				s, pool, _, _ := channelDeliveryFixture(t)
				db = pool
				claim = s.deliverNext
				previous := messageLogger
				messageLogger = logger
				t.Cleanup(func() { messageLogger = previous })
			} else {
				s, pool, _, _ := dmOutboxFixture(t)
				db = pool
				claim = s.deliverNextDM
				previous := dmLogger
				dmLogger = logger
				t.Cleanup(func() { dmLogger = previous })
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if claim(ctx) {
				t.Fatal("cancelled claim reported progress")
			}
			if output.Len() != 0 {
				t.Errorf("normal cancellation produced an error log: %s", output.String())
			}
			output.Reset()
			expired, stop := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
			defer stop()
			claim(expired)
			if !strings.Contains(output.String(), "outbox claim failed") {
				t.Fatal("deadline failure was hidden")
			}
			output.Reset()
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			claim(context.Background())
			if !strings.Contains(output.String(), "outbox claim failed") {
				t.Fatal("database failure was hidden")
			}
		})
	}
}
