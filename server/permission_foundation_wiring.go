package main

import (
	"github.com/argeinfina/hichat/middleware"
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type permissionFoundationDependencies struct {
	Repositories *Repositories
	Hub          ws.Broadcaster
}
type permissionFoundation struct {
	Auth        *middleware.AuthUserCache
	Server      *middleware.PermissionCache
	Channel     services.ChannelPermissionRuntime
	Invalidator services.PermissionInvalidator
}

func (p permissionFoundation) Stop() {
	if p.Channel != nil {
		p.Channel.Stop()
	}
	if p.Server != nil {
		p.Server.Close()
	}
	if p.Auth != nil {
		p.Auth.Close()
	}
}

// initPermissionFoundation owns partial cache allocation until successful return.
// Each cache retains its independent invalidation and shutdown owner.
func initPermissionFoundation(deps permissionFoundationDependencies) (group permissionFoundation) {
	transferred := false
	defer func() {
		if !transferred {
			group.Stop()
		}
	}()
	group.Auth = middleware.NewAuthUserCache()
	group.Server = middleware.NewPermissionCache()
	repos := deps.Repositories
	group.Channel = services.NewChannelPermissionService(repos.ChannelPermission, repos.Role, repos.Channel, deps.Hub)
	group.Invalidator = services.NewMultiInvalidator(group.Channel, group.Server)
	transferred = true
	return group
}
