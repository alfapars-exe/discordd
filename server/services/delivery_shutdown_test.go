package services

import (
	"context"
	"database/sql"
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
			db.SetMaxOpenConns(1)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			held, err := db.Conn(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer held.Close()
			before := db.Stats().WaitCount
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
