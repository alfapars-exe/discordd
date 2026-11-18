package main

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
	"time"
)

type voiceRegistrationRecorder struct {
	join       ws.VoiceJoinCallback
	leave      ws.VoiceLeaveCallback
	state      ws.VoiceStateUpdateCallback
	admin      ws.VoiceAdminStateUpdateCallback
	move       ws.VoiceMoveUserCallback
	disconnect ws.VoiceDisconnectUserCallback
	watch      ws.ScreenShareWatchCallback
	activity   ws.VoiceActivityCallback
}

func (r *voiceRegistrationRecorder) OnVoiceJoin(cb ws.VoiceJoinCallback)               { r.join = cb }
func (r *voiceRegistrationRecorder) OnVoiceLeave(cb ws.VoiceLeaveCallback)             { r.leave = cb }
func (r *voiceRegistrationRecorder) OnVoiceStateUpdate(cb ws.VoiceStateUpdateCallback) { r.state = cb }
func (r *voiceRegistrationRecorder) OnVoiceAdminStateUpdate(cb ws.VoiceAdminStateUpdateCallback) {
	r.admin = cb
}
func (r *voiceRegistrationRecorder) OnVoiceMoveUser(cb ws.VoiceMoveUserCallback) { r.move = cb }
func (r *voiceRegistrationRecorder) OnVoiceDisconnectUser(cb ws.VoiceDisconnectUserCallback) {
	r.disconnect = cb
}
func (r *voiceRegistrationRecorder) OnScreenShareWatch(cb ws.ScreenShareWatchCallback) { r.watch = cb }
func (r *voiceRegistrationRecorder) OnVoiceActivity(cb ws.VoiceActivityCallback)       { r.activity = cb }

type voiceRoutingRecorder struct {
	services.VoiceService
	calls    [][]any
	contexts []context.Context
	err      error
}

func (r *voiceRoutingRecorder) JoinChannel(user, name, display, avatar, channel string, mute, deafen bool) error {
	r.calls = append(r.calls, []any{"join", user, name, display, avatar, channel, mute, deafen})
	return r.err
}
func (r *voiceRoutingRecorder) LeaveChannel(user string) error {
	r.calls = append(r.calls, []any{"leave", user})
	return r.err
}
func (r *voiceRoutingRecorder) UpdateState(user string, mute, deafen, stream *bool) error {
	r.calls = append(r.calls, []any{"state", user, mute, deafen, stream})
	return r.err
}
func (r *voiceRoutingRecorder) AdminUpdateState(ctx context.Context, actor, target string, mute, deafen *bool) error {
	r.contexts = append(r.contexts, ctx)
	r.calls = append(r.calls, []any{"admin", actor, target, mute, deafen})
	return r.err
}
func (r *voiceRoutingRecorder) MoveUser(ctx context.Context, actor, target, channel string) error {
	r.contexts = append(r.contexts, ctx)
	r.calls = append(r.calls, []any{"move", actor, target, channel})
	return r.err
}
func (r *voiceRoutingRecorder) AdminDisconnectUser(ctx context.Context, actor, target string) error {
	r.contexts = append(r.contexts, ctx)
	r.calls = append(r.calls, []any{"disconnect", actor, target})
	return r.err
}
func (r *voiceRoutingRecorder) WatchScreenShare(viewer, streamer string, watching bool) {
	r.calls = append(r.calls, []any{"watch", viewer, streamer, watching})
}
func (r *voiceRoutingRecorder) UpdateActivity(user string) {
	r.calls = append(r.calls, []any{"activity", user})
}

type voiceActivityUserRepo struct {
	repository.UserRepository
	contexts []context.Context
	ids      []string
}

func (r *voiceActivityUserRepo) UpdateLastVoiceActivity(ctx context.Context, id string) error {
	r.contexts = append(r.contexts, ctx)
	r.ids = append(r.ids, id)
	return nil
}

type voiceActivityChannelRepo struct {
	repository.ChannelRepository
	contexts []context.Context
	ids      []string
}

func (r *voiceActivityChannelRepo) GetByID(ctx context.Context, id string) (*models.Channel, error) {
	r.contexts = append(r.contexts, ctx)
	r.ids = append(r.ids, id)
	return &models.Channel{ServerID: "joined-server"}, nil
}

type voiceActivityServerRepo struct {
	repository.ServerRepository
	contexts []context.Context
	ids      []string
}

func (r *voiceActivityServerRepo) UpdateLastVoiceActivity(ctx context.Context, id string) error {
	r.contexts = append(r.contexts, ctx)
	r.ids = append(r.ids, id)
	return nil
}

func TestVoiceCallbackRegistrationRoutesPayloadsAndBoundsWork(t *testing.T) {
	for _, failed := range []bool{false, true} {
		name := "success"
		if failed {
			name = "service errors"
		}
		t.Run(name, func(t *testing.T) {
			registrar := &voiceRegistrationRecorder{}
			service := &voiceRoutingRecorder{}
			if failed {
				service.err = errors.New("fixture voice failure")
			}
			users, channels, servers := &voiceActivityUserRepo{}, &voiceActivityChannelRepo{}, &voiceActivityServerRepo{}
			registerVoiceCallbacks(registrar, service, users, channels, servers)
			if registrar.join == nil || registrar.leave == nil || registrar.state == nil || registrar.admin == nil || registrar.move == nil || registrar.disconnect == nil || registrar.watch == nil || registrar.activity == nil {
				t.Fatal("missing voice registration")
			}
			yes, no := true, false
			registrar.join("user", "username", "display", "avatar", "joined-channel", true, false)
			registrar.leave("leaver")
			registrar.state("user", &yes, nil, &no)
			registrar.admin("moderator", "target", nil, &no)
			registrar.move("mover", "target", "destination")
			registrar.disconnect("disconnecter", "target")
			registrar.watch("viewer", "streamer", true)
			registrar.activity("active-user")
			want := [][]any{{"join", "user", "username", "display", "avatar", "joined-channel", true, false}, {"leave", "leaver"}, {"state", "user", &yes, (*bool)(nil), &no}, {"admin", "moderator", "target", (*bool)(nil), &no}, {"move", "mover", "target", "destination"}, {"disconnect", "disconnecter", "target"}, {"watch", "viewer", "streamer", true}, {"activity", "active-user"}}
			if !reflect.DeepEqual(service.calls, want) {
				t.Fatalf("routing=%#v want=%#v", service.calls, want)
			}
			if failed {
				if len(users.ids)+len(channels.ids)+len(servers.ids) != 0 {
					t.Fatal("failed join wrote activity")
				}
			} else {
				if !reflect.DeepEqual(users.ids, []string{"user"}) || !reflect.DeepEqual(channels.ids, []string{"joined-channel"}) || !reflect.DeepEqual(servers.ids, []string{"joined-server"}) {
					t.Fatal("join bookkeeping used wrong identity")
				}
				if users.contexts[0] != channels.contexts[0] || users.contexts[0] != servers.contexts[0] {
					t.Fatal("join bookkeeping must share one budget")
				}
				service.contexts = append(service.contexts, users.contexts[0])
			}
			for _, ctx := range service.contexts {
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) > 5*time.Second || time.Until(deadline) < 3*time.Second {
					t.Fatal("missing bounded broadcast budget")
				}
				if !errors.Is(ctx.Err(), context.Canceled) {
					t.Fatal("callback did not release context")
				}
			}
		})
	}
}
