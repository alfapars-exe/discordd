package models

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
)

const CS2CanonicalGameID = "steam:730"
const CS2SteamAdapter = "cs2-steam"

var ErrInvalidCS2SteamInvite = errors.New("invalid CS2 Steam invite")

// CS2SteamJoinRecipe contains only a fixed-adapter recipe, never a launch URL,
// executable path, command arguments, or proof of Steam account/party ownership.
type CS2SteamJoinRecipe struct {
	Adapter   string `json:"adapter"`
	LobbyID   string `json:"lobbyId"`
	InviterID string `json:"inviterId"`
}

func validCS2SteamID(raw string, lobby bool) bool {
	if raw == "" || len(raw) > 20 || raw[0] == '0' {
		return false
	}
	for _, c := range raw {
		if c < '0' || c > '9' {
			return false
		}
	}
	value, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		return false
	}
	universe := value >> 56
	kind := (value >> 52) & 15
	instance := (value >> 32) & ((1 << 20) - 1)
	account := value & ((1 << 32) - 1)
	if universe != 1 || account == 0 {
		return false
	}
	if !lobby {
		return kind == 1 && instance == 1
	}
	const lobbyFlag uint64 = 1 << 18
	const allowed uint64 = lobbyFlag | (1 << 17) | 0xfff
	return kind == 8 && instance&lobbyFlag != 0 && instance & ^allowed == 0
}
func (recipe CS2SteamJoinRecipe) Validate() error {
	if recipe.Adapter != CS2SteamAdapter || !validCS2SteamID(recipe.LobbyID, true) || !validCS2SteamID(recipe.InviterID, false) {
		return ErrInvalidCS2SteamInvite
	}
	return nil
}

// ParseCS2SteamInvite is an exact grammar, with no trimming, decoding, URL
// normalization, title inference, shell interpretation or arbitrary endpoint.
func ParseCS2SteamInvite(raw string) (CS2SteamJoinRecipe, error) {
	const prefix = "steam://joinlobby/730/"
	if len(raw) > 64 || !strings.HasPrefix(raw, prefix) {
		return CS2SteamJoinRecipe{}, ErrInvalidCS2SteamInvite
	}
	pieces := strings.Split(strings.TrimPrefix(raw, prefix), "/")
	if len(pieces) != 2 {
		return CS2SteamJoinRecipe{}, ErrInvalidCS2SteamInvite
	}
	recipe := CS2SteamJoinRecipe{Adapter: CS2SteamAdapter, LobbyID: pieces[0], InviterID: pieces[1]}
	if err := recipe.Validate(); err != nil {
		return CS2SteamJoinRecipe{}, err
	}
	return recipe, nil
}
func DecodeCS2SteamJoinRecipe(raw []byte) (CS2SteamJoinRecipe, error) {
	if len(raw) > 256 {
		return CS2SteamJoinRecipe{}, ErrInvalidCS2SteamInvite
	}
	var keys map[string]json.RawMessage
	if json.Unmarshal(raw, &keys) != nil || len(keys) != 3 {
		return CS2SteamJoinRecipe{}, ErrInvalidCS2SteamInvite
	}
	for key := range keys {
		if key != "adapter" && key != "lobbyId" && key != "inviterId" {
			return CS2SteamJoinRecipe{}, ErrInvalidCS2SteamInvite
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var recipe CS2SteamJoinRecipe
	if decoder.Decode(&recipe) != nil || recipe.Validate() != nil {
		return CS2SteamJoinRecipe{}, ErrInvalidCS2SteamInvite
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return CS2SteamJoinRecipe{}, ErrInvalidCS2SteamInvite
	}
	return recipe, nil
}

// CS2SteamJoinURI builds only a validated fixed URI. It never invokes Steam.
func CS2SteamJoinURI(recipe CS2SteamJoinRecipe) (string, error) {
	if err := recipe.Validate(); err != nil {
		return "", err
	}
	return "steam://joinlobby/730/" + recipe.LobbyID + "/" + recipe.InviterID, nil
}
