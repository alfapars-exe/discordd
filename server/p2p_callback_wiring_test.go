package main

import (
	"errors"
	"reflect"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type p2pRegistrationRecorder struct {
	initiate ws.P2PCallInitiateCallback
	accept   ws.P2PCallAcceptCallback
	decline  ws.P2PCallDeclineCallback
	end      ws.P2PCallEndCallback
	signal   ws.P2PSignalCallback
}

func (r *p2pRegistrationRecorder) OnP2PCallInitiate(cb ws.P2PCallInitiateCallback) { r.initiate = cb }
func (r *p2pRegistrationRecorder) OnP2PCallAccept(cb ws.P2PCallAcceptCallback)     { r.accept = cb }
func (r *p2pRegistrationRecorder) OnP2PCallDecline(cb ws.P2PCallDeclineCallback)   { r.decline = cb }
func (r *p2pRegistrationRecorder) OnP2PCallEnd(cb ws.P2PCallEndCallback)           { r.end = cb }
func (r *p2pRegistrationRecorder) OnP2PSignal(cb ws.P2PSignalCallback)             { r.signal = cb }

type p2pRoutingRecorder struct {
	services.P2PCallService
	calls [][]any
	err   error
}

func (r *p2pRoutingRecorder) InitiateCall(actor, target string, kind models.P2PCallType) error {
	r.calls = append(r.calls, []any{"initiate", actor, target, kind})
	return r.err
}
func (r *p2pRoutingRecorder) AcceptCall(actor, id string) error {
	r.calls = append(r.calls, []any{"accept", actor, id})
	return r.err
}
func (r *p2pRoutingRecorder) DeclineCall(actor, id string) error {
	r.calls = append(r.calls, []any{"decline", actor, id})
	return r.err
}
func (r *p2pRoutingRecorder) EndCall(actor, id string) error {
	r.calls = append(r.calls, []any{"end", actor, id})
	return r.err
}
func (r *p2pRoutingRecorder) RelaySignal(actor, id string, signal ws.P2PSignalData) error {
	r.calls = append(r.calls, []any{"signal", actor, id, signal})
	return r.err
}

func TestP2PCallbackRegistrationRoutesEveryPayloadAndContainsServiceErrors(t *testing.T) {
	for _, failed := range []bool{false, true} {
		name := "success"
		if failed {
			name = "service errors"
		}
		t.Run(name, func(t *testing.T) {
			registrar := &p2pRegistrationRecorder{}
			service := &p2pRoutingRecorder{}
			if failed {
				service.err = errors.New("fixture service failure")
			}
			registerP2PCallbacks(registrar, service)
			if registrar.initiate == nil || registrar.accept == nil || registrar.decline == nil || registrar.end == nil || registrar.signal == nil {
				t.Fatal("missing P2P callback registration")
			}
			signal := ws.P2PSignalData{CallID: "signal-call"}
			registrar.initiate("caller", ws.P2PCallInitiateData{ReceiverID: "receiver", CallType: "video"})
			registrar.accept("acceptor", ws.P2PCallAcceptData{CallID: "accept-call"})
			registrar.decline("decliner", ws.P2PCallDeclineData{CallID: "decline-call"})
			registrar.end("ender", "end-call")
			registrar.signal("sender", signal)
			want := [][]any{{"initiate", "caller", "receiver", models.P2PCallType("video")}, {"accept", "acceptor", "accept-call"}, {"decline", "decliner", "decline-call"}, {"end", "ender", "end-call"}, {"signal", "sender", "signal-call", signal}}
			if !reflect.DeepEqual(service.calls, want) {
				t.Fatalf("routing=%#v want=%#v", service.calls, want)
			}
		})
	}
}
