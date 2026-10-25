package models

type AccountLifecycle struct {
	DisabledAt *int64 `json:"disabled_at"`
	Version    int64  `json:"-"`
}
