package main

// Stop only the cache workers owned by this service bundle. Their Stop methods
// are idempotent; public service interfaces and request contracts stay unchanged.
func stopServiceCacheWorkers(svcs *Services) {
	if svcs == nil {
		return
	}
	if svcs.ChannelPermission != nil {
		svcs.ChannelPermission.Stop()
	}
	if svcs.WSTicket != nil {
		svcs.WSTicket.Stop()
	}
}
