package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
)

type voiceStatePermissionStub struct {
	byServer map[string]*UserChannelPermissions
	err      map[string]error
	calls    []string
}

func (s *voiceStatePermissionStub) ResolveUserChannelPermissions(_ context.Context, userID, serverID string) (*UserChannelPermissions, error) {
	s.calls = append(s.calls, userID+":"+serverID)
	return s.byServer[serverID], s.err[serverID]
}

type voiceStateChannelStub struct {
	byServer map[string][]models.Channel
	err      map[string]error
}

type voiceStateMembershipStub struct {
	byServer map[string]bool
	err      map[string]error
}

func (s *voiceStateMembershipStub) IsMember(_ context.Context, serverID, _ string) (bool, error) {
	return s.byServer[serverID], s.err[serverID]
}

func (s *voiceStateChannelStub) GetAllByServer(_ context.Context, serverID string) ([]models.Channel, error) {
	return s.byServer[serverID], s.err[serverID]
}

func TestVoiceStateVisibilityFilterUsesServerMembershipAndEffectiveViewPermission(t *testing.T) {
	filter := NewVoiceStateVisibilityFilter(
		&voiceStatePermissionStub{byServer: map[string]*UserChannelPermissions{
			"server-a": {
				Base: models.PermViewChannel,
				Overrides: map[string]models.Permission{
					"hidden": 0,
				},
			},
			"server-b": {Base: 0, Overrides: map[string]models.Permission{"granted": models.PermViewChannel}},
		}},
		&voiceStateChannelStub{byServer: map[string][]models.Channel{
			"server-a": {
				{ID: "visible", ServerID: "server-a", Type: models.ChannelTypeVoice},
				{ID: "hidden", ServerID: "server-a", Type: models.ChannelTypeVoice},
				{ID: "text", ServerID: "server-a", Type: models.ChannelTypeText},
				{ID: "wrong-owner", ServerID: "server-b", Type: models.ChannelTypeVoice},
			},
			"server-b": {{ID: "granted", ServerID: "server-b", Type: models.ChannelTypeVoice}},
		}},
		&voiceStateMembershipStub{byServer: map[string]bool{"server-a": true, "server-b": true}},
	)
	states := []models.VoiceState{
		{UserID: "v1", ServerID: "server-a", ChannelID: "visible"},
		{UserID: "h1", ServerID: "server-a", ChannelID: "hidden"},
		{UserID: "t1", ServerID: "server-a", ChannelID: "text"},
		{UserID: "g1", ServerID: "server-b", ChannelID: "granted"},
		{UserID: "foreign", ServerID: "server-c", ChannelID: "visible"},
		{UserID: "mismatched", ServerID: "server-a", ChannelID: "not-in-server-a"},
		{UserID: "wrong-owner", ServerID: "server-a", ChannelID: "wrong-owner"},
	}

	got, err := filter.FilterVisibleVoiceStates(context.Background(), "viewer", []string{"server-a", "server-b"}, states)
	if err != nil {
		t.Fatalf("FilterVisibleVoiceStates: %v", err)
	}
	if len(got) != 2 || got[0].UserID != "v1" || got[1].UserID != "g1" {
		t.Fatalf("visible states = %+v, want only visible and explicitly granted voice channels", got)
	}
}

func TestVoiceStateVisibilityFilterFailsClosedForOnlyAffectedServer(t *testing.T) {
	boom := errors.New("permission lookup failed")
	filter := NewVoiceStateVisibilityFilter(
		&voiceStatePermissionStub{byServer: map[string]*UserChannelPermissions{
			"server-b": {Base: models.PermViewChannel},
		}, err: map[string]error{"server-a": boom}},
		&voiceStateChannelStub{byServer: map[string][]models.Channel{
			"server-a": {{ID: "a", ServerID: "server-a", Type: models.ChannelTypeVoice}},
			"server-b": {{ID: "b", ServerID: "server-b", Type: models.ChannelTypeVoice}},
		}},
		&voiceStateMembershipStub{byServer: map[string]bool{"server-a": true, "server-b": true}},
	)

	got, err := filter.FilterVisibleVoiceStates(context.Background(), "viewer", []string{"server-a", "server-b"}, []models.VoiceState{
		{UserID: "a-user", ServerID: "server-a", ChannelID: "a"},
		{UserID: "b-user", ServerID: "server-b", ChannelID: "b"},
	})
	if !errors.Is(err, boom) {
		t.Fatalf("error = %v, want wrapped lookup error", err)
	}
	if len(got) != 1 || got[0].UserID != "b-user" {
		t.Fatalf("states = %+v, want only state from successfully filtered server", got)
	}
}

func TestVoiceStateVisibilityFilterRejectsMissingViewer(t *testing.T) {
	filter := NewVoiceStateVisibilityFilter(&voiceStatePermissionStub{}, &voiceStateChannelStub{}, &voiceStateMembershipStub{})
	if _, err := filter.FilterVisibleVoiceStates(context.Background(), "", []string{"server"}, nil); err == nil {
		t.Fatal("expected missing viewer ID error")
	}
}

func TestVoiceStateVisibilityFilterRechecksMembershipForCachedServerIDs(t *testing.T) {
	filter := NewVoiceStateVisibilityFilter(
		&voiceStatePermissionStub{byServer: map[string]*UserChannelPermissions{"server": {Base: models.PermViewChannel}}},
		&voiceStateChannelStub{byServer: map[string][]models.Channel{"server": {{ID: "voice", ServerID: "server", Type: models.ChannelTypeVoice}}}},
		&voiceStateMembershipStub{byServer: map[string]bool{"server": false}},
	)
	got, err := filter.FilterVisibleVoiceStates(context.Background(), "viewer", []string{"server"}, []models.VoiceState{
		{UserID: "other", ServerID: "server", ChannelID: "voice"},
	})
	if err != nil {
		t.Fatalf("FilterVisibleVoiceStates: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("cached server membership leaked states: %+v", got)
	}
}
