package main

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/argeinfina/hichat/services"
)

type offerAdapterRecorder struct {
	calls      int
	context    context.Context
	user       string
	connection uint64
	input      services.GameJoinOfferInput
}

func (r *offerAdapterRecorder) SetOffer(ctx context.Context, user string, connection uint64, input services.GameJoinOfferInput) services.GameJoinOfferState {
	r.calls++
	r.context = ctx
	r.user = user
	r.connection = connection
	r.input = input
	return services.GameJoinOfferState{RequestID: input.RequestID, Accepted: true, OfferRevision: input.OfferRevision}
}
func validAdapterOffer() map[string]any {
	return map[string]any{"request_id": "request", "activity_epoch": "epoch", "source_game_id": "source", "canonical_game_id": "canonical", "offer_revision": float64(7), "recipe": nil}
}
func TestGameJoinOfferAdapterPreservesTypedDispatchAndCancelsContext(t *testing.T) {
	recorder := &offerAdapterRecorder{}
	result := gameJoinOfferCallback(recorder)("actor", 42, validAdapterOffer())
	if recorder.calls != 1 || recorder.user != "actor" || recorder.connection != 42 {
		t.Fatalf("wrong dispatch: %#v", recorder)
	}
	want := services.GameJoinOfferInput{RequestID: "request", ActivityEpoch: "epoch", SourceGameID: "source", CanonicalGameID: "canonical", OfferRevision: 7}
	if !reflect.DeepEqual(recorder.input, want) {
		t.Fatalf("typed offer: %#v", recorder.input)
	}
	if !reflect.DeepEqual(result, services.GameJoinOfferState{RequestID: "request", Accepted: true, OfferRevision: 7}) {
		t.Fatalf("response: %#v", result)
	}
	if _, ok := recorder.context.Deadline(); !ok {
		t.Fatal("dispatch has no bounded context")
	}
	if recorder.context.Err() != context.Canceled {
		t.Fatalf("adapter retained completed context: %v", recorder.context.Err())
	}
}
func TestGameJoinOfferAdapterRejectsInvalidPayloadWithoutDispatch(t *testing.T) {
	for _, name := range []string{"unknown field", "oversize", "missing field", "invalid revision", "invalid recipe", "marshal error", "null"} {
		t.Run(name, func(t *testing.T) {
			fields := validAdapterOffer()
			var data any = fields
			switch name {
			case "unknown field":
				fields["extra"] = true
			case "oversize":
				fields["request_id"] = strings.Repeat("x", 2049)
			case "missing field":
				delete(fields, "recipe")
			case "invalid revision":
				fields["offer_revision"] = -1
			case "invalid recipe":
				fields["recipe"] = map[string]any{"adapter": "unknown"}
			case "marshal error":
				data = make(chan int)
			case "null":
				data = nil
			}
			recorder := &offerAdapterRecorder{}
			if got := gameJoinOfferCallback(recorder)("actor", 42, data); got != nil || recorder.calls != 0 {
				t.Fatalf("invalid payload dispatched: %#v, calls=%d", got, recorder.calls)
			}
		})
	}
}
