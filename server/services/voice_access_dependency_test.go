package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/ws"
	"testing"
	"time"
)

type voiceAccessChoice struct {
	channel                           *models.Channel
	admission                         *models.VoiceAdmission
	err                               error
	gets, admissions, tokens, visible int
}

func (r *voiceAccessChoice) GetByID(context.Context, string) (*models.Channel, error) {
	r.gets++
	return r.channel, nil
}
func (r *voiceAccessChoice) VoiceAdmission(context.Context, string, string) (*models.VoiceAdmission, error) {
	r.admissions++
	return r.admission, r.err
}
func (r *voiceAccessChoice) VoiceTokenAccess(context.Context, string, string, time.Time) (*models.VoiceAdmission, *models.LiveKitInstance, int64, error) {
	r.tokens++
	return r.admission, nil, 0, r.err
}
func (r *voiceAccessChoice) VoiceVisibleUsers(context.Context, string, string, []string) ([]string, error) {
	r.visible++
	return []string{"member"}, r.err
}
func TestVoiceAccessDependencyExplicitAdmissionAndPortableMode(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		name := "portable"
		if enabled {
			name = "snapshot"
		}
		t.Run(name, func(t *testing.T) {
			base := &voiceAccessChoice{channel: &models.Channel{ID: "portable"}}
			access := &voiceAccessChoice{admission: &models.VoiceAdmission{Channel: models.Channel{ID: "snapshot"}}}
			runtime := VoiceRuntimeDependencies{}
			if enabled {
				runtime.VoiceAccess = access
			}
			service := NewVoiceService(base, nil, nil, nil, nil, nil, nil, nil, nil, nil, runtime).(*voiceService)
			t.Cleanup(service.ShutdownVoiceStateFanout)
			channel, admission, err := service.loadVoiceChannel(context.Background(), "user", "channel")
			if err != nil {
				t.Fatal(err)
			}
			if enabled {
				if channel.ID != "snapshot" || admission != access.admission || access.admissions != 1 || base.gets != 0 {
					t.Fatal("declared snapshot reader not used")
				}
			} else {
				if channel != base.channel || admission != nil || base.gets != 1 || base.admissions != 0 {
					t.Fatal("portable mode rediscovered a snapshot reader")
				}
			}
		})
	}
}
func TestVoiceAccessErrorsNeverFallBackAndVisibilityIsScoped(t *testing.T) {
	base := &voiceAccessChoice{channel: &models.Channel{ID: "channel", ServerID: "server", Type: models.ChannelTypeVoice}}
	access := &voiceAccessChoice{err: errors.New("snapshot unavailable")}
	hub := &fanoutTestHub{online: []string{"member"}}
	pushes := 0
	hub.BroadcastToUsersFn = func(users []string, _ ws.Event) {
		pushes++
		if len(users) != 1 || users[0] != "member" {
			t.Fatal("visibility recipients lost")
		}
	}
	service := NewVoiceService(base, nil, &voicePermissionChoice{}, hub, nil, fanoutTestMembers{ids: []string{"member"}}, nil, nil, nil, nil, VoiceRuntimeDependencies{VoiceAccess: access}).(*voiceService)
	t.Cleanup(service.ShutdownVoiceStateFanout)
	if _, _, err := service.loadVoiceChannel(context.Background(), "user", "channel"); !errors.Is(err, access.err) {
		t.Fatal("admission error lost")
	}
	if _, err := service.GenerateToken(context.Background(), "user", "name", "display", "server", "channel"); !errors.Is(err, access.err) {
		t.Fatal("token snapshot error lost")
	}
	batch := []voiceStateFanoutEvent{{queuedAt: time.Now(), serverID: "server", channelID: "channel", event: ws.Event{}}}
	service.voiceFanout.deliver(batch, map[string][]string{})
	if pushes != 0 || service.voiceFanout.dropped() != 1 || base.gets != 0 || access.tokens != 1 || access.visible != 1 {
		t.Fatal("snapshot failure fell back or published")
	}
	access.err = nil
	service.voiceFanout.deliver(batch, map[string][]string{})
	if pushes != 1 || base.gets != 0 || access.visible != 2 {
		t.Fatal("declared visibility reader not used")
	}
}
