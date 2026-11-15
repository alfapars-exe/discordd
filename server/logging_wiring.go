package main

import (
	"github.com/argeinfina/hichat/services"
	"github.com/argeinfina/hichat/ws"
)

type loggingDependencies struct {
	Repositories *Repositories
	Hub          ws.BroadcastAndOnline
}
type loggingServices struct {
	Audit services.AuditLogService
	App   services.AppLogRuntime
}

// initLoggingServices creates the audit and application log owners before
// their consumers. Workers start in main; callers register rollback immediately.
func initLoggingServices(deps loggingDependencies) loggingServices {
	repos := deps.Repositories
	audit := services.NewAuditLogService(repos.AuditLog, repos.User, repos.Role, deps.Hub, deps.Hub)
	app := services.NewAppLogService(repos.AppLog, repos.AppLog)
	return loggingServices{Audit: audit, App: app}
}
