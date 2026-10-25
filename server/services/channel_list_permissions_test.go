package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
)

type listPermissionCategories struct{ repository.CategoryRepository }

func (listPermissionCategories) GetAllByServer(context.Context, string) ([]models.Category, error) {
	return nil, nil
}

type listPermissionResolver struct{ fail bool }

func (listPermissionResolver) BuildVisibilityFilter(context.Context, string, string) (*ChannelVisibilityFilter, error) {
	return &ChannelVisibilityFilter{HasBaseView: true}, nil
}
func (r listPermissionResolver) ResolveUserChannelPermissions(_ context.Context, userID, serverID string) (*UserChannelPermissions, error) {
	if r.fail {
		return nil, errors.New("permission lookup unavailable")
	}
	if userID == "writer" {
		return &UserChannelPermissions{Base: models.PermViewChannel | models.PermReadMessages | models.PermSendMessages, Overrides: map[string]models.Permission{"denied": models.PermViewChannel | models.PermReadMessages}}, nil
	}
	return &UserChannelPermissions{Base: models.PermViewChannel | models.PermReadMessages}, nil
}
func TestChannelListPermissionsAreRecipientScoped(t *testing.T) {
	ctx := context.Background()
	stale := models.PermAll
	source := []models.Channel{{ID: "write", Type: models.ChannelTypeText, EffectivePermissions: &stale}, {ID: "denied", Type: models.ChannelTypeText}, {ID: "voice", Type: models.ChannelTypeVoice}}
	repo := &testutil.MockChannelRepo{GetAllByServerFn: func(context.Context, string) ([]models.Channel, error) { return source, nil }}
	svc := NewChannelService(repo, listPermissionCategories{}, nil, listPermissionResolver{}, nil, nil, nil)
	writer, err := svc.GetAllGrouped(ctx, "server", "writer")
	if err != nil {
		t.Fatal(err)
	}
	reader, err := svc.GetAllGrouped(ctx, "server", "reader")
	if err != nil {
		t.Fatal(err)
	}
	if !writer[0].Channels[0].EffectivePermissions.Has(models.PermSendMessages) {
		t.Fatal("writer lost send permission")
	}
	if reader[0].Channels[0].EffectivePermissions.Has(models.PermSendMessages) {
		t.Fatal("writer permission leaked to reader")
	}
	if writer[0].Channels[1].EffectivePermissions.Has(models.PermSendMessages) {
		t.Fatal("channel override ignored")
	}
	if writer[0].Channels[2].EffectivePermissions != nil {
		t.Fatal("non-text metadata must be absent")
	}
	if source[0].EffectivePermissions != &stale || *source[0].EffectivePermissions != models.PermAll {
		t.Fatal("shared repository value mutated")
	}
}
func TestChannelListPermissionResolutionFailureIsClosed(t *testing.T) {
	svc := NewChannelService(&testutil.MockChannelRepo{}, listPermissionCategories{}, nil, listPermissionResolver{fail: true}, nil, nil, nil)
	if _, err := svc.GetAllGrouped(context.Background(), "server", "writer"); err == nil {
		t.Fatal("missing permission map must not be treated as sendable")
	}
}
