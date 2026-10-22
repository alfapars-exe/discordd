package main

// registerCosmeticRoutes wires the profile-cosmetics endpoints (Faz G1).
// /api/users/me/cosmetics* act on the caller's own slots and plain-server
// switches - every lookup is scoped by user_id inside the service and
// repository, so plain auth is the gate (a server scope additionally checks
// membership in the service, with the same 404 as a missing item). The
// global lookup returns only global slots, which are as public as an
// avatar (same class as the profile endpoint). The server map is gated by
// membership and returns only that server's members.
func (d *routeDeps) registerCosmeticRoutes() {
	d.mux.Handle("GET /api/users/me/cosmetics", d.auth(d.h.Cosmetic.GetMine))
	d.mux.Handle("PUT /api/users/me/cosmetics/equipped", d.auth(d.h.Cosmetic.Equip))
	d.mux.Handle("PUT /api/users/me/cosmetics/plain-servers/{serverId}", d.auth(d.h.Cosmetic.SetPlainServer))
	d.mux.Handle("GET /api/users/cosmetics", d.auth(d.h.Cosmetic.LookupGlobal))
	d.mux.Handle("GET /api/servers/{serverId}/cosmetics", d.authServer(d.h.Cosmetic.ServerCosmetics))
}
