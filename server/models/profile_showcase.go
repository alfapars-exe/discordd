package models

import (
	"errors"
	"net/url"
	"strings"
)

var ErrProfileShowcaseInvalid = errors.New("invalid profile showcase")

type ProfileTheme struct {
	Primary   string `json:"primary"`
	Secondary string `json:"secondary"`
}

type ProfileWidget struct {
	ID    string   `json:"id"`
	Type  string   `json:"type"`
	Title string   `json:"title,omitempty"`
	Game  string   `json:"game,omitempty"`
	URL   string   `json:"url,omitempty"`
	Items []string `json:"items,omitempty"`
}

type ProfileLink struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	URL     string `json:"url"`
	Visible bool   `json:"visible"`
}

type ProfileShowcase struct {
	ScopeServerID string          `json:"scope_server_id,omitempty"`
	Theme         ProfileTheme    `json:"theme"`
	Watching      string          `json:"watching,omitempty"`
	Widgets       []ProfileWidget `json:"widgets"`
	Links         []ProfileLink   `json:"links"`
	Version       int64           `json:"version"`
	UpdatedAt     string          `json:"updated_at,omitempty"`
}

var showcaseWidgetTypes = map[string]bool{
	"favorite_game": true, "liked_games": true, "rotation_games": true,
	"wishlist": true, "game_link": true,
}

func (p *ProfileShowcase) Validate() error {
	if len([]rune(strings.TrimSpace(p.Watching))) > 80 || len(p.Widgets) > 12 || len(p.Links) > 12 {
		return ErrProfileShowcaseInvalid
	}
	if !validOptionalHex(p.Theme.Primary) || !validOptionalHex(p.Theme.Secondary) {
		return ErrProfileShowcaseInvalid
	}
	ids := map[string]bool{}
	for i := range p.Widgets {
		w := &p.Widgets[i]
		w.ID, w.Type, w.Title, w.Game, w.URL = strings.TrimSpace(w.ID), strings.TrimSpace(w.Type), strings.TrimSpace(w.Title), strings.TrimSpace(w.Game), strings.TrimSpace(w.URL)
		if w.ID == "" || len(w.ID) > 64 || ids[w.ID] || !showcaseWidgetTypes[w.Type] || len([]rune(w.Title)) > 80 || len([]rune(w.Game)) > 100 || len(w.Items) > 50 {
			return ErrProfileShowcaseInvalid
		}
		ids[w.ID] = true
		if w.URL != "" && !validPublicProfileURL(w.URL) {
			return ErrProfileShowcaseInvalid
		}
		for _, item := range w.Items {
			if len([]rune(strings.TrimSpace(item))) > 100 {
				return ErrProfileShowcaseInvalid
			}
		}
	}
	ids = map[string]bool{}
	for i := range p.Links {
		l := &p.Links[i]
		l.ID, l.Label, l.URL = strings.TrimSpace(l.ID), strings.TrimSpace(l.Label), strings.TrimSpace(l.URL)
		if l.ID == "" || len(l.ID) > 64 || ids[l.ID] || len([]rune(l.Label)) < 1 || len([]rune(l.Label)) > 40 || !validPublicProfileURL(l.URL) {
			return ErrProfileShowcaseInvalid
		}
		ids[l.ID] = true
	}
	p.Watching = strings.TrimSpace(p.Watching)
	return nil
}

func validOptionalHex(s string) bool {
	if s == "" {
		return true
	}
	if len(s) != 7 || s[0] != '#' {
		return false
	}
	for _, r := range s[1:] {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}

func validPublicProfileURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Hostname() != "" && u.User == nil && len(raw) <= 2048
}
