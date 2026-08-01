// Regression net for the non-canonical-path ACL bypass (pentest 2026-07-26,
// finding C-02; confirmed still open by the 2026-07-31 scan).
//
// Serve made its authorization decision from the RAW path
// (fileURL := "/api/uploads/" + name) but read the bytes through path.Clean.
// Go's ServeMux does not canonicalise %2e into a path segment, so
// `/api/uploads/%2e/<name>` arrived as `./<name>`:
//
//	ACL lookup  -> "/api/uploads/./<name>"  misses both attachment tables
//	              -> MediaPublic (the fail-open default at the time of the finding)
//	byte read   -> path.Clean folds it back to the real private file
//
// Result: any DM or private-channel attachment was downloadable with NO
// authentication by anyone who knew its URL — and URLs are shared by design.
//
// The existing TestServe_RefusesPathTraversal covers escaping the upload dir.
// It could not catch this one: the bypass never leaves the directory, it only
// makes the ACL string and the disk path disagree. That is the gap this file
// pins.
//
// Fix location note: the guard lives in Serve, not only in MediaAccessService.
// MediaAccessService has since been rewritten to fail closed (a fileURL that
// matches no ownership table and no positive public-asset check now resolves
// to MediaNotFound, not MediaPublic — see services/media_access_service.go),
// which independently closes the auth-bypass angle of this finding. But the
// canonical-path guard here stays as a second, cheaper layer: it removes the
// ACL-string-vs-disk-path disagreement at the source instead of relying on
// every current and future MediaAccessService check to keep failing closed on
// a mismatched string.
package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestServe_RejectsNonCanonicalACLBypass is the C-02 pin. Every row targets a
// PRIVATE channel attachment and is sent UNAUTHENTICATED: before the fix the
// %2e row returned 200 with the real bytes.
func TestServe_RejectsNonCanonicalACLBypass(t *testing.T) {
	h, _, _ := newServeWorld(t)

	secret := "bytes-of-" + serveChannelFile

	variants := []struct {
		name string
		path string
	}{
		{"percent-encoded dot segment", "/api/uploads/%2e/" + serveChannelFile},
		{"literal dot segment", "/api/uploads/./" + serveChannelFile},
		{"percent-encoded leading slash", "/api/uploads/%2f" + serveChannelFile},
		{"doubled slash", "/api/uploads//" + serveChannelFile},
		{"trailing dot segment", "/api/uploads/" + serveChannelFile + "/."},
	}

	for _, tc := range variants {
		t.Run(tc.name, func(t *testing.T) {
			// userID "" => no credential at all.
			rec := serveAs(t, h, tc.path, "")

			if rec.Code == http.StatusOK {
				t.Fatalf("unauthenticated %q returned 200 — ACL bypassed", tc.path)
			}
			if strings.Contains(rec.Body.String(), secret) {
				t.Fatalf("unauthenticated %q leaked the private attachment body", tc.path)
			}
		})
	}
}

// TestServe_CanonicalPathsStillWork guards the other direction: the canonical
// guard must not break the three legitimate outcomes. Without this, a guard
// that simply 404'd everything would pass the test above.
func TestServe_CanonicalPathsStillWork(t *testing.T) {
	h, _, _ := newServeWorld(t)

	t.Run("private attachment, unauthenticated -> 401 not 404", func(t *testing.T) {
		// Proves the canonical guard did not swallow the request: the ACL still
		// runs and still reports "authentication required" for this file. A 404
		// here would mean the guard is over-matching on a legitimate name.
		rec := serveAs(t, h, "/api/uploads/"+serveChannelFile, "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})

	t.Run("private attachment, permitted member -> 200", func(t *testing.T) {
		rec := serveAs(t, h, "/api/uploads/"+serveChannelFile, serveChannelMemberID)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), "bytes-of-"+serveChannelFile) {
			t.Fatalf("member did not receive the attachment body")
		}
	})

	t.Run("public asset, unauthenticated -> 200", func(t *testing.T) {
		// The MediaPublic path is load-bearing for avatars, server icons,
		// soundboard samples and branding. servePublicFile is registered as
		// a positive public asset in newServeWorld's fake publicAssets repo
		// (see upload_download_test.go), so it passes MediaAccessService's
		// POSITIVE public-asset check and still resolves to MediaPublic even
		// after the fail-closed rewrite. This row does not exercise the
		// fail-closed dip — the dip only changed the outcome for paths that
		// match NEITHER an ownership table NOR a positive public-asset check,
		// which this one is not, so it stays green either way. (Previously
		// this comment said the opposite — that the fix "would break" this
		// case if applied in MediaAccessService — which contradicted the
		// file's own header above once the fix landed there too.)
		rec := serveAs(t, h, "/api/uploads/"+servePublicFile, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
		}
	})
}

// TestServe_NonCanonicalThroughRealMux drives the bypass through a real
// http.ServeMux registered exactly as production does
// (init_routes_global.go:67), instead of calling h.Serve directly.
//
// Why this exists: the whole C-02 chain rests on how the stdlib router treats
// %2e — whether it redirects, rewrites, or hands the handler a "." segment.
// The other tests in this file assert the handler's behaviour given that input;
// only this one checks the assumption itself. A Go upgrade or a router swap
// that changes the decode/clean order would silently invalidate the reasoning
// in Serve's comment while every other test stayed green.
//
// The assertion is deliberately about the SECURITY OUTCOME, not the mechanism:
// whatever the router decides to do, an unauthenticated caller must never
// receive the private bytes. That keeps the pin valid across stdlib changes.
func TestServe_NonCanonicalThroughRealMux(t *testing.T) {
	h, _, _ := newServeWorld(t)

	mux := http.NewServeMux()
	mux.Handle("GET /api/uploads/", http.HandlerFunc(h.Serve))

	secret := "bytes-of-" + serveChannelFile

	for _, target := range []string{
		"/api/uploads/%2e/" + serveChannelFile,
		"/api/uploads/%2e%2f" + serveChannelFile,
		"/api/uploads/" + serveChannelFile + "/%2e",
	} {
		t.Run(target, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, target, nil)
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if rec.Code == http.StatusOK {
				t.Fatalf("unauthenticated %q returned 200 through the real mux", target)
			}
			if strings.Contains(rec.Body.String(), secret) {
				t.Fatalf("unauthenticated %q leaked the private attachment through the real mux", target)
			}
			// Recorded, not asserted: tells a future reader whether the router
			// or the handler stopped it, so a behaviour change is visible in
			// the log even when the security property still holds.
			t.Logf("router+handler outcome for %q: %d", target, rec.Code)
		})
	}
}
