package main

import (
	"net"
	"net/http"
	"strconv"
	"time"
)

// Maintenance starts before opening the DB or any background writer. It lets
// a deployment build while the final source snapshot is being verified.
func maintenanceHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodGet && r.URL.Path == "/api/health" {
		_, _ = w.Write([]byte(`{"status":"maintenance","service":"hichat"}`))
		return
	}
	w.Header().Set("Retry-After", "30")
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = w.Write([]byte(`{"success":false,"code":"MAINTENANCE","error":"Service temporarily unavailable"}`))
}

func serveMaintenance(host string, port int) error {
	server := &http.Server{Addr: net.JoinHostPort(host, strconv.Itoa(port)), Handler: http.HandlerFunc(maintenanceHandler), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	return server.ListenAndServe()
}
