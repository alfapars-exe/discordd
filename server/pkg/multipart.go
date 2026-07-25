// Package pkg — multipart parsing with a hard body cap.
//
// Go's r.ParseMultipartForm(maxMemory) only controls how much of the
// payload is kept in memory; anything larger spills to a tempfile under
// $TMPDIR. The function will happily walk a multi-gigabyte body to disk
// before returning, which is a textbook DoS vector for any public upload
// endpoint.
//
// LimitedParseMultipartForm wraps r.Body in http.MaxBytesReader BEFORE
// the parser starts pulling bytes, so the request is rejected with 413
// the moment it exceeds maxBytes. The in-memory portion is still bounded
// by maxBytes (parser internals), but the on-disk spill can never grow
// past the hard cap.
//
// `maxBytes` is the per-request ceiling. For multi-file forms (the
// channel and DM message endpoints accept N attachments), this should be
// `per_file_max * N + overhead` where overhead covers multipart boundary
// markers, JSON metadata fields, etc.
package pkg

import (
	"mime/multipart"
	"net/http"
)

// multipartHeaderOverhead is the budget we add on top of the file payload
// limit for multipart boundary markers, Content-Disposition headers, and
// non-file form fields (content, reply_to_id, e2ee_metadata, etc).
const multipartHeaderOverhead = 1 * 1024 * 1024 // 1 MiB

// LimitedParseMultipartForm caps the request body before parsing. Use
// this instead of r.ParseMultipartForm in every upload handler.
//
// Returns the same error r.ParseMultipartForm would return, plus the
// http.MaxBytesReader sentinel (`*http.MaxBytesError`) when the cap is hit.
// Callers can detect that case and respond with 413 specifically; the
// existing handlers already collapse all parse errors into a generic
// "failed to parse multipart form" 400, which is acceptable for the
// initial rollout.
func LimitedParseMultipartForm(w http.ResponseWriter, r *http.Request, maxBytes int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+multipartHeaderOverhead)
	return r.ParseMultipartForm(maxBytes) // #nosec G120 -- r.Body was just wrapped in http.MaxBytesReader on the line above; gosec's pattern match doesn't trace that mutation, but the parse is bounded (this whole file exists to provide that bound)
}

// LimitedParseMultipartFormN is the multi-file variant: maxBytesPerFile
// is the per-file limit, n is the maximum number of files the endpoint
// accepts. The total cap is `maxBytesPerFile * n + overhead`.
//
// `n` should be set conservatively — a handler that loops over an
// unbounded number of files should pick a sane attachment-count limit
// (most chat backends settle on 5-10).
func LimitedParseMultipartFormN(w http.ResponseWriter, r *http.Request, maxBytesPerFile int64, n int) error {
	if n < 1 {
		n = 1
	}
	totalCap := maxBytesPerFile*int64(n) + multipartHeaderOverhead
	r.Body = http.MaxBytesReader(w, r.Body, totalCap)
	return r.ParseMultipartForm(maxBytesPerFile) // #nosec G120 -- r.Body was just wrapped in http.MaxBytesReader on the line above; gosec's pattern match doesn't trace that mutation, but the parse is bounded (this whole file exists to provide that bound)
}

// Compile-time guard that the package still imports multipart — the
// upload services hold *multipart.FileHeader values that ultimately come
// from forms parsed by this helper, and keeping the import here prevents
// goimports from "fixing" the package by deleting the visibility of the
// type that callers depend on transitively.
var _ multipart.File = (multipart.File)(nil)
