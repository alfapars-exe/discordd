package models

import (
	"strings"
	"testing"
	"time"
)

func int64Ptr(v int64) *int64 { return &v }

func TestBanRequest_Validate(t *testing.T) {
	const oneYear = 365 * 24 * 60 * 60

	tests := []struct {
		name    string
		req     BanRequest
		wantErr bool
	}{
		{"nil duration (permanent) accepted", BanRequest{DurationSeconds: nil}, false},
		{"zero duration rejected", BanRequest{DurationSeconds: int64Ptr(0)}, true},
		{"negative duration rejected", BanRequest{DurationSeconds: int64Ptr(-1)}, true},
		{"exactly 1 year accepted", BanRequest{DurationSeconds: int64Ptr(oneYear)}, false},
		{"1 year + 1s rejected", BanRequest{DurationSeconds: int64Ptr(oneYear + 1)}, true},
		{"reason at 512 runes accepted", BanRequest{Reason: strings.Repeat("a", 512)}, false},
		{"reason over 512 runes rejected", BanRequest{Reason: strings.Repeat("a", 513)}, true},
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

func TestBanRequest_ResolvedExpiresAt(t *testing.T) {
	t.Run("nil duration resolves to nil (permanent)", func(t *testing.T) {
		req := BanRequest{DurationSeconds: nil}
		if got := req.ResolvedExpiresAt(); got != nil {
			t.Errorf("ResolvedExpiresAt() = %v, want nil", got)
		}
	})

	t.Run("duration resolves to ~now+d", func(t *testing.T) {
		req := BanRequest{DurationSeconds: int64Ptr(3600)}
		before := time.Now().UTC()
		got := req.ResolvedExpiresAt()
		after := time.Now().UTC()

		if got == nil {
			t.Fatal("expected non-nil ResolvedExpiresAt for a temp ban")
		}
		wantMin := before.Add(3600 * time.Second)
		wantMax := after.Add(3600 * time.Second)
		if got.Before(wantMin) || got.After(wantMax) {
			t.Errorf("ResolvedExpiresAt() = %v, want between %v and %v", *got, wantMin, wantMax)
		}
	})
}
