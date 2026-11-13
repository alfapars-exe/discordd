package main

// Stop only the cache workers owned by this service bundle. Their Stop methods
// are idempotent; public service interfaces and request contracts stay unchanged.
func stopServiceCacheWorkers(svcs *Services) {
	if svcs == nil {
		return
	}
	for _, service := range []any{svcs.ChannelPermission, svcs.WSTicket} {
		if owner, ok := service.(interface{ Stop() }); ok {
			owner.Stop()
		}
	}
}
