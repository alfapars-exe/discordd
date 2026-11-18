package main

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/ws"
	"reflect"
	"testing"
	"time"
)

type gameActivityRegistrationRecorder struct {
	connect    ws.GameActivityConnectionCallback
	update     ws.GameActivityUpdateCallback
	disconnect ws.GameActivityConnectionCallback
	snapshot   ws.GameActivitySnapshotCallback
	presence   ws.GameActivitySnapshotCallback
}

func (r *gameActivityRegistrationRecorder) OnGameActivityConnect(cb ws.GameActivityConnectionCallback) {
	r.connect = cb
}
func (r *gameActivityRegistrationRecorder) OnGameActivityUpdate(cb ws.GameActivityUpdateCallback) {
	r.update = cb
}
func (r *gameActivityRegistrationRecorder) OnGameActivityDisconnect(cb ws.GameActivityConnectionCallback) {
	r.disconnect = cb
}
func (r *gameActivityRegistrationRecorder) OnGameActivitySnapshot(cb ws.GameActivitySnapshotCallback) {
	r.snapshot = cb
}
func (r *gameActivityRegistrationRecorder) OnGameActivityPresenceChange(cb ws.GameActivitySnapshotCallback) {
	r.presence = cb
}

type gameActivityRoutingRecorder struct {
	calls            [][]any
	contexts         []context.Context
	started, stopped int
}

func (r *gameActivityRoutingRecorder) Start() { r.started++ }
func (r *gameActivityRoutingRecorder) Stop()  { r.stopped++ }
func (r *gameActivityRoutingRecorder) Connect(user string, id uint64) {
	r.calls = append(r.calls, []any{"connect", user, id})
}
func (r *gameActivityRoutingRecorder) Update(ctx context.Context, user string, id, sequence uint64, game *ws.GameActivityClientGame) {
	r.contexts = append(r.contexts, ctx)
	r.calls = append(r.calls, []any{"update", user, id, sequence, game})
}
func (r *gameActivityRoutingRecorder) Disconnect(ctx context.Context, user string, id uint64) {
	r.contexts = append(r.contexts, ctx)
	r.calls = append(r.calls, []any{"disconnect", user, id})
}
func (r *gameActivityRoutingRecorder) Snapshot(ctx context.Context, user string) {
	r.contexts = append(r.contexts, ctx)
	r.calls = append(r.calls, []any{"snapshot", user})
}
func (r *gameActivityRoutingRecorder) PolicyChanged(ctx context.Context, user string) {
	r.contexts = append(r.contexts, ctx)
	r.calls = append(r.calls, []any{"presence", user})
}

func TestGameActivityCallbacksDisabledRuntimeRegistersNothing(t *testing.T) {
	registrar := &gameActivityRegistrationRecorder{}
	stop := registerGameActivityCallbacks(registrar, nil)
	stop()
	stop()
	if !reflect.DeepEqual(registrar, &gameActivityRegistrationRecorder{}) {
		t.Fatal("disabled game activity registered callbacks")
	}
}

func TestGameActivityCallbacksRouteConnectionSequenceAndOwnLifecycle(t *testing.T) {
	registrar := &gameActivityRegistrationRecorder{}
	runtime := &gameActivityRoutingRecorder{}
	stop := registerGameActivityCallbacks(registrar, runtime)
	t.Cleanup(func() {
		if runtime.stopped == 0 {
			stop()
		}
	})
	if runtime.started != 1 || runtime.stopped != 0 {
		t.Fatal("runtime must start exactly once at registration")
	}
	if registrar.connect == nil || registrar.update == nil || registrar.disconnect == nil || registrar.snapshot == nil || registrar.presence == nil {
		t.Fatal("missing game activity registration")
	}
	game := &ws.GameActivityClientGame{}
	registrar.connect("connected", 42)
	registrar.update("playing", 43, 9, game)
	registrar.update("cleared", 44, 10, nil)
	registrar.disconnect("disconnected", 45)
	registrar.snapshot("viewer")
	registrar.presence("policy-user")
	want := [][]any{{"connect", "connected", uint64(42)}, {"update", "playing", uint64(43), uint64(9), game}, {"update", "cleared", uint64(44), uint64(10), (*ws.GameActivityClientGame)(nil)}, {"disconnect", "disconnected", uint64(45)}, {"snapshot", "viewer"}, {"presence", "policy-user"}}
	if !reflect.DeepEqual(runtime.calls, want) {
		t.Fatalf("routing=%#v want=%#v", runtime.calls, want)
	}
	for _, ctx := range runtime.contexts {
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 5*time.Second || !errors.Is(ctx.Err(), context.Canceled) {
			t.Fatal("callback must bound and release its context")
		}
	}
	stop()
	if runtime.stopped != 1 {
		t.Fatal("cleanup did not stop the installed runtime")
	}
}
