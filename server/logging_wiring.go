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
	for _, input := range []struct {
		name  string
		value any
	}{{"Repositories", deps.Repositories}, {"Hub", deps.Hub}} {
		if missingCompositionInput(input.value) {
			panic("logging requires " + input.name)
		}
	}
	repos := deps.Repositories
	for _, input := range []struct {
		name  string
		value any
	}{{"AuditLog", repos.AuditLog}, {"User", repos.User}, {"Role", repos.Role}, {"AppLog", repos.AppLog}} {
		if missingCompositionInput(input.value) {
			panic("logging requires repository " + input.name)
		}
	}
	audit := services.NewAuditLogService(repos.AuditLog, repos.User, repos.Role, deps.Hub, deps.Hub)
	app := services.NewAppLogService(repos.AppLog, repos.AppLog)
	return loggingServices{Audit: audit, App: app}
}
