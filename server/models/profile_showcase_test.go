package models

import "testing"

func TestProfileShowcaseValidate(t *testing.T) {
	valid := ProfileShowcase{
		Theme:    ProfileTheme{Primary: "#5865f2", Secondary: "#111214"},
		Watching: "A live stream",
		Widgets:  []ProfileWidget{{ID: "w1", Type: "favorite_game", Items: []string{"Game"}}, {ID: "w2", Type: "game_link", URL: "https://example.com/game"}},
		Links:    []ProfileLink{{ID: "l1", Label: "Website", URL: "https://example.com", Visible: true}},
	}
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*ProfileShowcase){
		"bad color":        func(p *ProfileShowcase) { p.Theme.Primary = "red" },
		"duplicate widget": func(p *ProfileShowcase) { p.Widgets = append(p.Widgets, p.Widgets[0]) },
		"javascript link":  func(p *ProfileShowcase) { p.Links[0].URL = "javascript:alert(1)" },
		"credentials":      func(p *ProfileShowcase) { p.Links[0].URL = "https://user:pass@example.com" },
		"unknown widget":   func(p *ProfileShowcase) { p.Widgets[0].Type = "payment" },
	} {
		t.Run(name, func(t *testing.T) {
			copy := valid
			copy.Widgets = append([]ProfileWidget(nil), valid.Widgets...)
			copy.Links = append([]ProfileLink(nil), valid.Links...)
			mutate(&copy)
			if err := copy.Validate(); err == nil {
				t.Fatal("invalid profile accepted")
			}
		})
	}
}
