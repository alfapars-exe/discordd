package main

import (
	"bytes"
	"context"
	"encoding/json"

	"github.com/argeinfina/hichat/services"
)

type gameJoinOfferWriter interface {
	SetOffer(context.Context, string, uint64, services.GameJoinOfferInput) services.GameJoinOfferState
}

// gameJoinOfferCallback adapts decoded WebSocket data to the typed service.
// Domain authorization remains in GameJoinService; startup only connects it.
func gameJoinOfferCallback(writer gameJoinOfferWriter) func(string, uint64, any) any {
	return func(user string, connection uint64, data any) any {
		raw, err := json.Marshal(data)
		if err != nil || len(raw) > 2048 {
			return nil
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		var input services.GameJoinOfferInput
		if decoder.Decode(&input) != nil {
			return nil
		}
		ctx, cancel := services.BroadcastContext()
		defer cancel()
		return writer.SetOffer(ctx, user, connection, input)
	}
}
