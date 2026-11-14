package main

import (
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

// p2pCallbackRegistrar is the transport registration boundary. Service routing
// can be verified without starting sockets or exposing the Hub callback fields.
type p2pCallbackRegistrar interface {
	OnP2PCallInitiate(ws.P2PCallInitiateCallback)
	OnP2PCallAccept(ws.P2PCallAcceptCallback)
	OnP2PCallDecline(ws.P2PCallDeclineCallback)
	OnP2PCallEnd(ws.P2PCallEndCallback)
	OnP2PSignal(ws.P2PSignalCallback)
}

func registerP2PCallbacks(hub p2pCallbackRegistrar, p2pCallService services.P2PCallService) {
	hub.OnP2PCallInitiate(func(callerID string, data ws.P2PCallInitiateData) {
		callType := models.P2PCallType(data.CallType)
		if err := p2pCallService.InitiateCall(callerID, data.ReceiverID, callType); err != nil {
			hubLogger.Error("p2p call initiate failed", "area", "p2p", "caller_id", callerID, "receiver_id", data.ReceiverID, "err", pkg.ErrText(err))
		}
	})
	hub.OnP2PCallAccept(func(userID string, data ws.P2PCallAcceptData) {
		if err := p2pCallService.AcceptCall(userID, data.CallID); err != nil {
			hubLogger.Error("p2p call accept failed", "area", "p2p", "user_id", userID, "call_id", data.CallID, "err", pkg.ErrText(err))
		}
	})
	hub.OnP2PCallDecline(func(userID string, data ws.P2PCallDeclineData) {
		if err := p2pCallService.DeclineCall(userID, data.CallID); err != nil {
			hubLogger.Error("p2p call decline failed", "area", "p2p", "user_id", userID, "call_id", data.CallID, "err", pkg.ErrText(err))
		}
	})
	hub.OnP2PCallEnd(func(userID, callID string) {
		if err := p2pCallService.EndCall(userID, callID); err != nil {
			hubLogger.Error("p2p call end failed", "area", "p2p", "user_id", userID, "err", pkg.ErrText(err))
		}
	})
	hub.OnP2PSignal(func(senderID string, data ws.P2PSignalData) {
		if err := p2pCallService.RelaySignal(senderID, data.CallID, data); err != nil {
			hubLogger.Error("p2p signal relay failed", "area", "p2p", "sender_id", senderID, "call_id", data.CallID, "err", pkg.ErrText(err))
		}
	})

}
