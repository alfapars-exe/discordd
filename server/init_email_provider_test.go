package main

import (
	"fmt"
	"testing"

	"github.com/argeinfina/hichat/config"
	"github.com/google/uuid"
)

func TestConfiguredEmailProviderRequiresCompleteOptionalConfiguration(t *testing.T) {
	for mask := 0; mask < 8; mask++ {
		t.Run(fmt.Sprintf("configured-fields-%03b", mask), func(t *testing.T) {
			cfg := config.EmailConfig{}
			if mask&1 != 0 {
				cfg.ResendAPIKey = uuid.NewString()
			}
			if mask&2 != 0 {
				cfg.FromEmail = "sender@example.invalid"
			}
			if mask&4 != 0 {
				cfg.AppURL = "https://example.invalid"
			}
			provider := configuredEmailProvider(cfg)
			if mask != 7 {
				if provider != nil {
					t.Fatal("partial optional configuration enabled a provider")
				}
				return
			}
			if provider == nil {
				t.Fatal("complete configuration disabled provider")
			}
			if got := provider.CategoryFrom(); got != "HiChat <sender@example.invalid>" {
				t.Fatalf("provider lost sender configuration: %q", got)
			}
		})
	}
}
