package middleware

import (
	"net/http"
	"strings"
)

// MaxRequestBodyBytes is the global, non-multipart request body cap
// (security scan 2026-07-31, finding N-14). Before this middleware, the
// largest bounded JSON body in the codebase was maxGroupSessionBody
// (handlers/e2ee.go, 1 MiB); everything else that read the body with
// json.Decoder had no cap at all. 8 MiB is 8x that existing bound -- generous
// enough that no legitimate JSON caller is affected, while closing the
// unbounded-body DoS surface on every route this middleware wraps.
const MaxRequestBodyBytes = 8 << 20 // 8 MiB

// BodyLimit returns middleware that caps the request body via
// http.MaxBytesReader for every request EXCEPT multipart/form-data ones.
//
// Multipart requests are deliberately exempt: the eight upload endpoints
// (avatar, badge, diagnostics, dm, feedback, message, report, soundboard)
// already call pkg.LimitedParseMultipartForm[N] with their own -- much
// larger -- per-endpoint limits (UPLOAD_MAX_SIZE, default 25 MiB, sometimes
// multiplied by an attachment count). Applying an 8 MiB global cap on top of
// those would silently truncate legitimate uploads before the handler's own
// limit ever runs.
//
// http.MaxBytesReader nests safely: a handler that wraps r.Body in a
// smaller reader again (e.g. maxClientLogBody's 16 KiB) still enforces its
// own tighter limit, since http.MaxBytesReader tracks remaining bytes on
// whatever reader it wraps.
func BodyLimit(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
				next.ServeHTTP(w, r)
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}
