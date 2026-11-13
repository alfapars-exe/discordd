package main

import "context"

// startBackendOwnerWatch launches the database ownership observer.
func startBackendOwnerWatch(ctx context.Context, watch func(context.Context)) func() {
	go watch(ctx)
	return func() {}
}
