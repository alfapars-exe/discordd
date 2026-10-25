package ws

import "testing"

func TestValidGameActivityInputRejectsPathsAndBoundsMetadata(t *testing.T) {
	tests := []struct {
		name string
		game *GameActivityClientGame
		want bool
	}{
		{name: "valid manual title", game: &GameActivityClientGame{ID: "9a9e2f00-c849-4e5e-a608-e4dafeaaf97e", Name: "Example Game"}, want: true},
		{name: "path-like name", game: &GameActivityClientGame{ID: "9a9e2f00-c849-4e5e-a608-e4dafeaaf97e", Name: `C:\\Games\\game.exe`}},
		{name: "non UUID ID", game: &GameActivityClientGame{ID: "game.exe", Name: "Example Game"}},
		{name: "control character", game: &GameActivityClientGame{ID: "9a9e2f00-c849-4e5e-a608-e4dafeaaf97e", Name: "Example\nGame"}},
		{name: "overlong title", game: &GameActivityClientGame{ID: "9a9e2f00-c849-4e5e-a608-e4dafeaaf97e", Name: string(make([]byte, 81))}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := validGameActivityInput(tt.game); got != tt.want {
				t.Fatalf("validGameActivityInput = %v, want %v", got, tt.want)
			}
		})
	}
}
