package database

import (
	"testing"
	"time"
)

func TestPostgresPoolLimits(t *testing.T) {
	for _, tc := range []struct {
		open, idle         string
		wantOpen, wantIdle int
		invalid            bool
	}{{"", "", 8, 8, false}, {"4", "", 4, 4, false}, {"", "3", 8, 3, false}, {"8", "3", 8, 3, false}, {"4", "0", 4, 0, false}, {"0", "0", 0, 0, true}, {"3", "4", 0, 0, true}, {"oops", "2", 0, 0, true}, {"257", "2", 0, 0, true}} {
		t.Run(tc.open+"_"+tc.idle, func(t *testing.T) {
			t.Setenv("POSTGRES_MAX_OPEN_CONNS", tc.open)
			t.Setenv("POSTGRES_MAX_IDLE_CONNS", tc.idle)
			o, i, err := postgresPoolLimits()
			if (err != nil) != tc.invalid {
				t.Fatalf("err=%v", err)
			}
			if !tc.invalid && (o != tc.wantOpen || i != tc.wantIdle) {
				t.Fatalf("limits=%d/%d", o, i)
			}
		})
	}
}

func TestPostgresConnMaxIdleTime(t *testing.T) {
	for _, tc := range []struct {
		raw     string
		want    time.Duration
		invalid bool
	}{{"", 5 * time.Minute, false}, {"1", time.Second, false}, {"900", 15 * time.Minute, false}, {"1800", postgresConnMaxLifetime, false}, {"0", 0, true}, {"-1", 0, true}, {"1801", 0, true}, {"5m", 0, true}, {"oops", 0, true}} {
		t.Run(tc.raw, func(t *testing.T) {
			t.Setenv("POSTGRES_CONN_MAX_IDLE_SECONDS", tc.raw)
			got, err := postgresConnMaxIdleTime()
			if (err != nil) != tc.invalid {
				t.Fatalf("err=%v", err)
			}
			if got != tc.want {
				t.Fatalf("idle time=%s, want %s", got, tc.want)
			}
		})
	}
}
