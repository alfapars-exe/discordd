package main

import "context"

// startBackendOwnerWatch owns the observer until cancellation and completion.
// Stop does not cancel the caller context; repeated/concurrent callers all wait
// for the same observer before its connection or database pool can close.
func startBackendOwnerWatch(parent context.Context, watch func(context.Context)) func() {
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	go func() { defer close(done); watch(ctx) }()
	return func() { cancel(); <-done }
}
