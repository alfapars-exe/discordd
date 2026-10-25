package services

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/argeinfina/hichat/pkg"
)

// ServerDMPolicy controls only new conversations between non-friends who share
// one or more servers. Existing history is intentionally left reachable.
type ServerDMPolicy interface {
	CanCreate(context.Context, string, string) (bool, error)
}

type RepositoryServerDMPolicy struct {
	prefs   profilePreferenceReader
	servers friendRequestServerReader
}

func NewServerDMPolicy(prefs profilePreferenceReader, servers friendRequestServerReader) ServerDMPolicy {
	return &RepositoryServerDMPolicy{prefs: prefs, servers: servers}
}

type serverDMPreferences struct {
	Privacy struct {
		ServerDMDefault   *bool           `json:"serverDMDefault"`
		ServerDMOverrides map[string]bool `json:"serverDMOverrides"`
	} `json:"privacy"`
}

func readServerDMPreferences(ctx context.Context, prefs profilePreferenceReader, userID string) (serverDMPreferences, error) {
	var result serverDMPreferences
	stored, err := prefs.Get(ctx, userID)
	if err != nil {
		return result, err
	}
	return parseServerDMPreferences(stored.Data)
}

func parseServerDMPreferences(data json.RawMessage) (serverDMPreferences, error) {
	var result serverDMPreferences
	if len(data) > 0 {
		if err := json.Unmarshal(data, &result); err != nil {
			return result, fmt.Errorf("%w: invalid stored server-DM preferences", pkg.ErrInternal)
		}
	}
	return result, nil
}

func serverDMAllowed(prefs serverDMPreferences, serverID string) bool {
	if allowed, exists := prefs.Privacy.ServerDMOverrides[serverID]; exists {
		return allowed
	}
	return prefs.Privacy.ServerDMDefault == nil || *prefs.Privacy.ServerDMDefault
}

func sharedAllowedServer(senderServers, targetServers []string, prefs serverDMPreferences) (shared, allowed bool) {
	senderSet := make(map[string]struct{}, len(senderServers))
	for _, id := range senderServers {
		senderSet[id] = struct{}{}
	}
	for _, id := range targetServers {
		if _, ok := senderSet[id]; !ok {
			continue
		}
		shared = true
		if serverDMAllowed(prefs, id) {
			allowed = true
		}
	}
	return shared, allowed
}

func (p *RepositoryServerDMPolicy) CanCreate(ctx context.Context, senderID, targetID string) (bool, error) {
	prefs, err := readServerDMPreferences(ctx, p.prefs, targetID)
	if err != nil {
		return false, err
	}
	senderServers, err := p.servers.GetMemberServerIDs(ctx, senderID)
	if err != nil {
		return false, err
	}
	targetServers, err := p.servers.GetMemberServerIDs(ctx, targetID)
	if err != nil {
		return false, err
	}
	shared, allowed := sharedAllowedServer(senderServers, targetServers, prefs)
	return !shared || allowed, nil
}
