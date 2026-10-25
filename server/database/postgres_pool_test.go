package database

import "testing"

func TestPostgresPoolLimits(t *testing.T) {
	for _, tc := range []struct {
		open, idle         string
		wantOpen, wantIdle int
		invalid            bool
	}{{"", "", 4, 2, false}, {"8", "3", 8, 3, false}, {"4", "0", 4, 0, false}, {"0", "0", 0, 0, true}, {"3", "4", 0, 0, true}, {"oops", "2", 0, 0, true}, {"257", "2", 0, 0, true}} {
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
