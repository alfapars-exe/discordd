package main

import "context"

// startBackendOwnerWatch owns the observer until cancellation and completion.
// Stop does not cancel the caller context; repeated/concurrent callers all wait
// for the same observer before its connection or database pool can close.
// Natural completion also releases the child context before publishing done.
func startBackendOwnerWatch(parent context.Context, watch func(context.Context)) func() {
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer cancel()
		watch(ctx)
	}()
	return func() { cancel(); <-done }
}
