package repository

import (
	"database/sql"
	"testing"
)

func TestServerEventNoticePreferenceFailsClosedForMalformedConsent(t *testing.T) {
	for _, tc := range []struct {
		name string
		raw  sql.NullString
		want bool
	}{
		{"missing row", sql.NullString{}, true},
		{"missing namespace", sql.NullString{String: `{}`, Valid: true}, true},
		{"missing field", sql.NullString{String: `{"notifications":{}}`, Valid: true}, true},
		{"enabled", sql.NullString{String: `{"notifications":{"upcomingEventNotifications":true}}`, Valid: true}, true},
		{"disabled", sql.NullString{String: `{"notifications":{"upcomingEventNotifications":false}}`, Valid: true}, false},
		{"null root", sql.NullString{String: `null`, Valid: true}, false},
		{"null namespace", sql.NullString{String: `{"notifications":null}`, Valid: true}, false},
		{"null field", sql.NullString{String: `{"notifications":{"upcomingEventNotifications":null}}`, Valid: true}, false},
		{"string field", sql.NullString{String: `{"notifications":{"upcomingEventNotifications":"true"}}`, Valid: true}, false},
		{"array root", sql.NullString{String: `[]`, Valid: true}, false},
		{"broken JSON", sql.NullString{String: `{`, Valid: true}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := serverEventNoticePreferenceEnabled(tc.raw); got != tc.want {
				t.Fatalf("enabled=%v, want %v", got, tc.want)
			}
		})
	}
}
