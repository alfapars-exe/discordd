package services

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/ws"
)

// PreferencesService validates and synchronizes account-scoped preferences.
type PreferencesService interface {
	Get(ctx context.Context, userID string) (*models.UserPreferences, error)
	Update(ctx context.Context, userID string, partial json.RawMessage) (*models.UserPreferences, error)
}

type preferencesService struct {
	repo                       repository.PreferencesRepository
	gameActivity               GameActivityPolicyInvalidator
	profileAudienceInvalidator ProfileAudienceInvalidator
	hub                        ws.Broadcaster
}

type GameActivityPolicyInvalidator interface{ PolicyChanged(context.Context, string) }

func (s *preferencesService) SetGameActivitySync(policy GameActivityPolicyInvalidator, hub ws.Broadcaster) {
	s.gameActivity, s.hub = policy, hub
}

func (s *preferencesService) SetProfileAudienceInvalidator(invalidator ProfileAudienceInvalidator) {
	s.profileAudienceInvalidator = invalidator
}

// NewPreferencesService creates a new PreferencesService.
func NewPreferencesService(repo repository.PreferencesRepository) PreferencesService {
	return &preferencesService{repo: repo}
}

func (s *preferencesService) Get(ctx context.Context, userID string) (*models.UserPreferences, error) {
	prefs, err := s.repo.Get(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get preferences: %w", err)
	}
	return normalizePreferences(prefs)
}

func (s *preferencesService) Update(ctx context.Context, userID string, partial json.RawMessage) (*models.UserPreferences, error) {
	if err := (&models.UpdatePreferencesRequest{Data: partial}).Validate(); err != nil {
		return nil, fmt.Errorf("invalid preferences data: %w", pkg.ErrBadRequest)
	}
	filtered, err := models.FilterDeviceLocalPreferences(partial)
	if err != nil {
		return nil, fmt.Errorf("filter preferences: %w", err)
	}
	var audienceViewers []string
	if updatesProfileAudience(filtered) && s.profileAudienceInvalidator != nil {
		oldPrefs, err := s.repo.Get(ctx, userID)
		if err != nil {
			return nil, fmt.Errorf("read profile audience before update: %w", err)
		}
		oldAudience, err := profileAudienceFromPreferences(oldPrefs)
		if err != nil {
			return nil, fmt.Errorf("read profile audience before update: %w", err)
		}
		newAudience, err := profileAudienceFromPreferences(&models.UserPreferences{Data: filtered})
		if err != nil {
			return nil, fmt.Errorf("validate profile audience update: %w", err)
		}
		audienceViewers, err = s.profileAudienceInvalidator.ListProfileAudienceViewers(ctx, userID, oldAudience, newAudience)
		if err != nil {
			return nil, fmt.Errorf("resolve profile audience invalidation recipients: %w", err)
		}
	}
	prefs, err := s.repo.Upsert(ctx, userID, filtered)
	if err != nil {
		return nil, fmt.Errorf("update preferences: %w", err)
	}
	if s.gameActivity != nil {
		s.gameActivity.PolicyChanged(ctx, userID)
	}
	if s.hub != nil {
		s.hub.BroadcastToUser(userID, ws.Event{Op: ws.OpPreferencesChanged, Data: map[string]string{"user_id": userID}})
		if len(audienceViewers) > 0 {
			s.hub.BroadcastToUsers(audienceViewers, ws.Event{
				Op:   ws.OpProfileAudienceInvalidated,
				Data: map[string]string{"user_id": userID},
			})
		}
	}
	return normalizePreferences(prefs)
}

// updatesProfileAudience reports whether the patch explicitly changes the
// account-scoped profile audience. The invalidation event carries only the
// target ID; no profile or preference values are broadcast.
func updatesProfileAudience(patch json.RawMessage) bool {
	var root map[string]json.RawMessage
	if json.Unmarshal(patch, &root) != nil {
		return false
	}
	var privacy map[string]json.RawMessage
	if json.Unmarshal(root["privacy"], &privacy) != nil {
		return false
	}
	_, ok := privacy["profileAudience"]
	return ok
}

func normalizePreferences(prefs *models.UserPreferences) (*models.UserPreferences, error) {
	if prefs == nil {
		return nil, fmt.Errorf("preferences repository returned no result")
	}
	filtered, err := models.FilterDeviceLocalPreferences(prefs.Data)
	if err != nil {
		return nil, fmt.Errorf("read preferences: %w", err)
	}
	result := *prefs
	result.SchemaVersion = models.PreferencesSchemaVersion
	result.Data = filtered
	return &result, nil
}
