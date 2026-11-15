package main

import (
	"github.com/argeinfina/hichat/pkg/email"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type communicationDependencies struct {
	Repositories *Repositories
	Hub          ws.BroadcastAndOnline
	Sender       email.CategorySender
	Logger       services.P2PAppLogger
	AppURL       string
}
type communicationServices struct {
	EmailDelivery *services.EmailDeliveryService
	P2PCall       services.P2PCallService
}

// initCommunicationServices shares the durable email enqueue owner with P2P
// signaling; email worker startup and P2P callbacks remain separately owned.
func initCommunicationServices(deps communicationDependencies) communicationServices {
	repos := deps.Repositories
	delivery := services.NewEmailDeliveryService(repos.EmailDelivery, deps.Sender, services.WithEmailUnsubscribe(repos.EmailUnsubscribe, deps.AppURL))
	calls := services.NewP2PCallService(repos.Friendship, repos.User, deps.Hub, delivery, deps.Logger)
	return communicationServices{EmailDelivery: delivery, P2PCall: calls}
}
