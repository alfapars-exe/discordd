// Package services — server LiveKit settings: non-secret voice-instance info for the settings UI.
package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/pkg"
)

// LiveKitSettings exposes non-secret LiveKit info for the settings UI.
type LiveKitSettings struct {
	URL               string `json:"url"`
	IsPlatformManaged bool   `json:"is_platform_managed"`
}

// GetLiveKitSettings returns non-secret LiveKit info for the settings page.
func (s *serverService) GetLiveKitSettings(ctx context.Context, serverID string) (*LiveKitSettings, error) {
	server, err := s.serverRepo.GetByID(ctx, serverID)
	if err != nil {
		return nil, err
	}

	if server.LiveKitInstanceID == nil {
		return nil, fmt.Errorf("%w: this server has no LiveKit instance", pkg.ErrNotFound)
	}

	instance, err := s.livekitRepo.GetByID(ctx, *server.LiveKitInstanceID)
	if err != nil {
		return nil, fmt.Errorf("failed to get livekit instance: %w", err)
	}

	return &LiveKitSettings{
		URL:               instance.URL,
		IsPlatformManaged: instance.IsPlatformManaged,
	}, nil
}
