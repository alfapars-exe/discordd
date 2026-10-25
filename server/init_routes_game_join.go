package main

func (d *routeDeps) registerGameJoinRoutes() {
	d.mux.Handle("POST /api/game-join/targets", d.auth(d.h.GameJoin.Targets))
	d.mux.Handle("POST /api/game-join/tickets", d.auth(d.h.GameJoin.Mint))
	d.mux.Handle("POST /api/game-join/tickets/consume", d.auth(d.h.GameJoin.Consume))
}
