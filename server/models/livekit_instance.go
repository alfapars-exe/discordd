package models

import (
	"fmt"
	"strings"
	"time"
)

// LiveKitInstance — credentials are stored AES-256-GCM encrypted in DB.
// Values here are decrypted; json:"-" prevents them from ever reaching the client.
type LiveKitInstance struct {
	ID                string    `json:"id"`
	URL               string    `json:"url"`
	APIKey            string    `json:"-"`
	APISecret         string    `json:"-"`
	IsPlatformManaged bool      `json:"is_platform_managed"`
	ServerCount       int       `json:"server_count"`
	MaxServers        int       `json:"max_servers"` // 0 = unlimited
	HetznerServerID   string    `json:"hetzner_server_id"`
	CreatedAt         time.Time `json:"created_at"`

	// Quota and auto-switch fields. Cloud (is_platform_managed=true) instances
	// get a monthly minute budget; voice tokens fail over to the next eligible
	// instance when remaining minutes drop below SwitchThresholdMinutes. Self-
	// hosted (is_platform_managed=false) instances ignore these fields entirely.
	Priority               int  `json:"priority"`                 // lower = preferred for auto-switch
	MonthlyQuotaMinutes    int  `json:"monthly_quota_minutes"`    // billing ceiling (default 5000)
	QuotaResetDay          int  `json:"quota_reset_day"`          // day-of-month when budget resets (1..28)
	AutoSwitchEnabled      bool `json:"auto_switch_enabled"`      // participates in fail-over rotation
	SwitchThresholdMinutes int  `json:"switch_threshold_minutes"` // remaining min < this → migrate (default 20)
}

// LiveKitInstanceAdminView — credentials are NEVER exposed, even to admins.
type LiveKitInstanceAdminView struct {
	ID                     string    `json:"id"`
	URL                    string    `json:"url"`
	IsPlatformManaged      bool      `json:"is_platform_managed"`
	ServerCount            int       `json:"server_count"`
	MaxServers             int       `json:"max_servers"`
	HetznerServerID        string    `json:"hetzner_server_id"`
	CreatedAt              time.Time `json:"created_at"`
	Priority               int       `json:"priority"`
	MonthlyQuotaMinutes    int       `json:"monthly_quota_minutes"`
	QuotaResetDay          int       `json:"quota_reset_day"`
	AutoSwitchEnabled      bool      `json:"auto_switch_enabled"`
	SwitchThresholdMinutes int       `json:"switch_threshold_minutes"`
}

// LiveKitInstanceQuotaView — admin view with current-month usage joined in
// and convenience fields (RemainingMinutes, DaysUntilReset) computed server-
// side so the UI doesn't have to repeat the same date arithmetic per row.
type LiveKitInstanceQuotaView struct {
	LiveKitInstanceAdminView
	UsedMinutes      int `json:"used_minutes"`      // sum of completed sessions, this billing cycle
	RemainingMinutes int `json:"remaining_minutes"` // max(MonthlyQuotaMinutes - UsedMinutes, 0)
	DaysUntilReset   int `json:"days_until_reset"`  // calendar days from today to next QuotaResetDay
}

type CreateLiveKitInstanceRequest struct {
	URL             string `json:"url"`
	APIKey          string `json:"api_key"`
	APISecret       string `json:"api_secret"`
	MaxServers      int    `json:"max_servers"`
	HetznerServerID string `json:"hetzner_server_id"`
	// IsPlatformManaged toggles between LiveKit Cloud (default true — quota
	// tracked, eligible for auto-switch) and a user-supplied self-hosted SFU
	// (false — unlimited, bypassed by quota & auto-switch logic). Pointer
	// would let us tell "absent" from "explicit false", but the UI always
	// sends one of the two — bool with a true default works.
	IsPlatformManaged *bool `json:"is_platform_managed"`
}

func (r *CreateLiveKitInstanceRequest) Validate() error {
	r.URL = strings.TrimSpace(r.URL)
	if r.URL == "" {
		return fmt.Errorf("url is required")
	}
	r.APIKey = strings.TrimSpace(r.APIKey)
	if r.APIKey == "" {
		return fmt.Errorf("api_key is required")
	}
	r.APISecret = strings.TrimSpace(r.APISecret)
	if r.APISecret == "" {
		return fmt.Errorf("api_secret is required")
	}
	if r.MaxServers < 0 {
		return fmt.Errorf("max_servers must be >= 0")
	}
	return nil
}

// UpdateLiveKitInstanceRequest — nil fields are not updated.
// Empty credentials keep existing values.
type UpdateLiveKitInstanceRequest struct {
	URL                    *string `json:"url"`
	APIKey                 *string `json:"api_key"`
	APISecret              *string `json:"api_secret"`
	MaxServers             *int    `json:"max_servers"`
	HetznerServerID        *string `json:"hetzner_server_id"`
	IsPlatformManaged      *bool   `json:"is_platform_managed"`
	Priority               *int    `json:"priority"`
	MonthlyQuotaMinutes    *int    `json:"monthly_quota_minutes"`
	QuotaResetDay          *int    `json:"quota_reset_day"`
	AutoSwitchEnabled      *bool   `json:"auto_switch_enabled"`
	SwitchThresholdMinutes *int    `json:"switch_threshold_minutes"`
}

// UpdateLiveKitQuotaSettingsRequest — narrow payload for the quota panel's
// PATCH endpoint. Splitting it from the general update keeps the credential-
// touching path (URL/APIKey/APISecret) safely separate; the quota PATCH
// endpoint never accepts secrets.
type UpdateLiveKitQuotaSettingsRequest struct {
	Priority               *int  `json:"priority"`
	MonthlyQuotaMinutes    *int  `json:"monthly_quota_minutes"`
	QuotaResetDay          *int  `json:"quota_reset_day"`
	AutoSwitchEnabled      *bool `json:"auto_switch_enabled"`
	SwitchThresholdMinutes *int  `json:"switch_threshold_minutes"`
}

func (r *UpdateLiveKitQuotaSettingsRequest) Validate() error {
	if r.Priority != nil && *r.Priority < 0 {
		return fmt.Errorf("priority must be >= 0")
	}
	if r.MonthlyQuotaMinutes != nil && *r.MonthlyQuotaMinutes < 0 {
		return fmt.Errorf("monthly_quota_minutes must be >= 0")
	}
	if r.QuotaResetDay != nil && (*r.QuotaResetDay < 1 || *r.QuotaResetDay > 28) {
		// Cap at 28 so the date arithmetic never has to special-case Feb.
		return fmt.Errorf("quota_reset_day must be between 1 and 28")
	}
	if r.SwitchThresholdMinutes != nil && *r.SwitchThresholdMinutes < 0 {
		return fmt.Errorf("switch_threshold_minutes must be >= 0")
	}
	return nil
}

func (r *UpdateLiveKitInstanceRequest) Validate() error {
	if r.URL != nil {
		trimmed := strings.TrimSpace(*r.URL)
		r.URL = &trimmed
		if trimmed == "" {
			return fmt.Errorf("url cannot be empty")
		}
	}
	if r.APIKey != nil {
		trimmed := strings.TrimSpace(*r.APIKey)
		r.APIKey = &trimmed
		if trimmed == "" {
			return fmt.Errorf("api_key cannot be empty")
		}
	}
	if r.APISecret != nil {
		trimmed := strings.TrimSpace(*r.APISecret)
		r.APISecret = &trimmed
		if trimmed == "" {
			return fmt.Errorf("api_secret cannot be empty")
		}
	}
	if r.MaxServers != nil && *r.MaxServers < 0 {
		return fmt.Errorf("max_servers must be >= 0")
	}
	if r.Priority != nil && *r.Priority < 0 {
		return fmt.Errorf("priority must be >= 0")
	}
	if r.MonthlyQuotaMinutes != nil && *r.MonthlyQuotaMinutes < 0 {
		return fmt.Errorf("monthly_quota_minutes must be >= 0")
	}
	if r.QuotaResetDay != nil && (*r.QuotaResetDay < 1 || *r.QuotaResetDay > 28) {
		return fmt.Errorf("quota_reset_day must be between 1 and 28")
	}
	if r.SwitchThresholdMinutes != nil && *r.SwitchThresholdMinutes < 0 {
		return fmt.Errorf("switch_threshold_minutes must be >= 0")
	}
	return nil
}
