package models

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCS2SteamJoinSharedParity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "cs2-join-parity.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name   string `json:"name"`
		Invite string `json:"invite"`
		Valid  bool   `json:"valid"`
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 30 {
		t.Fatal("parity matrix unexpectedly incomplete")
	}
	for _, entry := range cases {
		t.Run(entry.Name, func(t *testing.T) {
			recipe, err := ParseCS2SteamInvite(entry.Invite)
			if (err == nil) != entry.Valid {
				t.Fatalf("valid=%v, want %v", err == nil, entry.Valid)
			}
			if err == nil {
				uri, err := CS2SteamJoinURI(recipe)
				if err != nil || uri != entry.Invite {
					t.Fatal("round trip changed canonical bytes")
				}
				encoded, _ := json.Marshal(recipe)
				copy, err := DecodeCS2SteamJoinRecipe(encoded)
				if err != nil || copy != recipe {
					t.Fatal("typed JSON recipe failed round trip")
				}
			}
		})
	}
}
func TestCS2SteamRecipeRejectsAuthorityAndUnknownFields(t *testing.T) {
	for _, raw := range []string{`null`, `[]`, `{"Adapter":"cs2-steam","lobbyId":"1","inviterId":"1"}`, `{"adapter":"cs2-steam","lobbyId":123,"inviterId":"1"}`, `{"adapter":"cs2-steam","lobbyId":"1","inviterId":"1","url":"steam://run/730"}`, `{"adapter":"other","lobbyId":"1","inviterId":"1"}`, `{} {}`} {
		if _, err := DecodeCS2SteamJoinRecipe([]byte(raw)); err == nil {
			t.Fatal("accepted invalid recipe")
		}
	}
}
