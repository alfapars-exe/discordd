package models

import (
	"strings"
	"testing"
	"time"
)

func TestTimeoutRequest_Validate(t *testing.T) {
	tests := []struct {
		name    string
		req     TimeoutRequest
		wantErr bool
	}{
		{"zero duration rejected", TimeoutRequest{DurationSeconds: 0}, true},
		{"negative duration rejected", TimeoutRequest{DurationSeconds: -1}, true},
		{"one second accepted", TimeoutRequest{DurationSeconds: 1}, false},
		{"exactly 28 days accepted", TimeoutRequest{DurationSeconds: 28 * 24 * 60 * 60}, false},
		{"28 days + 1s rejected", TimeoutRequest{DurationSeconds: 28*24*60*60 + 1}, true},
		{"reason at 512 runes accepted", TimeoutRequest{DurationSeconds: 60, Reason: strings.Repeat("a", 512)}, false},
		{"reason over 512 runes rejected", TimeoutRequest{DurationSeconds: 60, Reason: strings.Repeat("a", 513)}, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.req.Validate()
			if (err != nil) != tt.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestTimeoutRequest_ExpiresAt(t *testing.T) {
	req := TimeoutRequest{DurationSeconds: 300}
	before := time.Now().UTC()
	got := req.ExpiresAt()
	after := time.Now().UTC()

	wantMin := before.Add(300 * time.Second)
	wantMax := after.Add(300 * time.Second)
	if got.Before(wantMin) || got.After(wantMax) {
		t.Errorf("ExpiresAt() = %v, want between %v and %v", got, wantMin, wantMax)
	}
}
