package services

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
)

// resolveChannelInServer confirms the channel referenced by a request actually
// belongs to serverID, returning pkg.ErrNotFound otherwise — so a caller can't
// act on a channel in a server they don't have access to by mismatching
// serverID/channelID. Shared by the message and pin services, which each
// previously carried a byte-identical private copy (validateChannelScope).
func resolveChannelInServer(ctx context.Context, channelRepo repository.ChannelRepository, serverID, channelID string) (*models.Channel, error) {
	channel, err := channelRepo.GetByID(ctx, channelID)
	if err != nil {
		return nil, err
	}
	if channel.ServerID != serverID {
		return nil, fmt.Errorf("%w: channel not found", pkg.ErrNotFound)
	}
	return channel, nil
}
