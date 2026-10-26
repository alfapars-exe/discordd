package models

import "testing"

func TestProfileShowcaseEmptyCollectionsAndLinkLimit(t *testing.T) {
	p := ProfileShowcase{}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	if p.Links == nil || p.Widgets == nil {
		t.Fatal("empty collections must be arrays")
	}
	for i := 0; i < 12; i++ {
		p.Links = append(p.Links, ProfileLink{ID: string(rune('a' + i)), Label: "Site", URL: "https://example.com"})
	}
	if err := p.Validate(); err != nil {
		t.Fatalf("12 links rejected: %v", err)
	}
	p.Links = append(p.Links, ProfileLink{ID: "extra", Label: "Site", URL: "https://example.com"})
	if err := p.Validate(); err == nil {
		t.Fatal("13 links accepted")
	}
}

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
