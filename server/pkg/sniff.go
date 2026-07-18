// Package pkg — content-type sniffing for upload validation.
//
// http.DetectContentType inspects the first 512 bytes of a file and
// returns the MIME the bytes actually look like, regardless of what the
// client claimed in the multipart Content-Type header. The client header
// is fully attacker-controlled, so any MIME allowlist check that trusts
// it is trivially bypassed by labelling a JS shell or HTML XSS payload
// as image/png.
//
// SniffContentType reads up to 512 bytes from src, runs DetectContentType
// against the buffer, and returns:
//   - detected MIME (lowercase, parameters stripped)
//   - a Reader that replays the buffered bytes followed by the rest of src
//
// Callers MUST use the returned reader for any subsequent copy/save —
// the original src has had bytes consumed. The pattern is:
//
//	mime, body, err := pkg.SniffContentType(file)
//	if err != nil { ... }
//	io.Copy(dest, body)
package pkg

import (
	"bytes"
	"io"
	"net/http"
	"strings"
)

// SniffBufferSize matches the lookahead http.DetectContentType expects.
// Anything shorter weakens sniffing accuracy; anything longer is wasted.
const SniffBufferSize = 512

// SniffContentType reads up to 512 bytes from src, detects the real MIME
// type from the bytes, and returns the MIME plus a Reader that lets the
// caller still read the full original payload (sniff bytes + rest).
//
// On short reads (file smaller than 512 bytes) the buffer is still passed
// to DetectContentType — sniffing degrades gracefully.
func SniffContentType(src io.Reader) (mime string, body io.Reader, err error) {
	buf := make([]byte, SniffBufferSize)
	n, err := io.ReadFull(src, buf)
	// io.ErrUnexpectedEOF means the file is < 512 bytes — that's fine, we
	// sniff what we have. io.EOF means an empty file; pass that up.
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return "", nil, err
	}

	sniffed := http.DetectContentType(buf[:n])

	// Strip any "; charset=..." trailer so callers can compare against a
	// plain "image/png" allowlist without prefix matching.
	if semi := strings.IndexByte(sniffed, ';'); semi >= 0 {
		sniffed = strings.TrimSpace(sniffed[:semi])
	}

	replayed := io.MultiReader(bytes.NewReader(buf[:n]), src)
	return strings.ToLower(sniffed), replayed, nil
}

// SniffAndValidate is a one-shot helper for upload services. It sniffs
// the real MIME, checks it against the allowlist, and returns the
// replayed reader for the caller to save. Returns the sniffed MIME on
// success so callers can persist the *real* type instead of the
// client-supplied one.
//
// `claimedMIME` is the multipart Content-Type header, included for the
// "claimed vs actual" mismatch check — if the client said image/png and
// the bytes say application/x-msdownload, we surface that as an error.
// `allowlist` lookups happen against the SNIFFED MIME.
func SniffAndValidate(
	src io.Reader,
	claimedMIME string,
	allowlist map[string]bool,
) (realMIME string, body io.Reader, err error) {
	realMIME, body, err = SniffContentType(src)
	if err != nil {
		return "", nil, err
	}

	if !allowlist[realMIME] {
		return realMIME, body, &MIMETypeError{
			Detected: realMIME,
			Claimed:  claimedMIME,
		}
	}

	return realMIME, body, nil
}

// MIMETypeError is returned by SniffAndValidate when the sniffed MIME is
// not in the allowlist. Both the sniffed and claimed types are reported
// so logs can show "client said X, bytes were Y" — useful for tuning the
// allowlist and spotting active probing.
type MIMETypeError struct {
	Detected string
	Claimed  string
}

func (e *MIMETypeError) Error() string {
	if e.Claimed == "" || e.Claimed == e.Detected {
		return "file type not allowed: " + e.Detected
	}
	return "file type not allowed: declared " + e.Claimed + " but bytes are " + e.Detected
}

// extensionMIME is the controlled fallback map for filename-based
// classification. Kept small and explicit so we can't accidentally accept
// something http.DetectContentType and the allowlist both would reject.
//
// The real-world need: DetectContentType returns "application/ogg" for
// OGG containers (not "audio/ogg" per our allowlist) and
// "application/octet-stream" for raw MP3s without an ID3 tag. Without
// this fallback, valid uploads get 400ed.
var extensionMIME = map[string]string{
	"jpg":  "image/jpeg",
	"jpeg": "image/jpeg",
	"png":  "image/png",
	"gif":  "image/gif",
	"webp": "image/webp",
	"mp4":  "video/mp4",
	"webm": "video/webm",
	"mp3":  "audio/mpeg",
	"ogg":  "audio/ogg",
	"pdf":  "application/pdf",
	"txt":  "text/plain",
}

func extFromName(filename string) string {
	dot := strings.LastIndexByte(filename, '.')
	if dot < 0 || dot == len(filename)-1 {
		return ""
	}
	return strings.ToLower(filename[dot+1:])
}

// SniffOrExtension is SniffAndValidate with a controlled filename-extension
// fallback for cases where http.DetectContentType is technically correct
// but the resulting MIME isn't in the allowlist (OGG, raw MP3). Sniffing
// still wins whenever the bytes resolve to an allowed type — extension is
// only consulted when the sniffed type would otherwise be rejected.
func SniffOrExtension(
	src io.Reader,
	filename string,
	claimedMIME string,
	allowlist map[string]bool,
) (realMIME string, body io.Reader, err error) {
	sniffed, body, err := SniffContentType(src)
	if err != nil {
		return "", nil, err
	}

	if allowlist[sniffed] {
		return sniffed, body, nil
	}

	if candidate, ok := extensionMIME[extFromName(filename)]; ok && allowlist[candidate] {
		return candidate, body, nil
	}

	return sniffed, body, &MIMETypeError{
		Detected: sniffed,
		Claimed:  claimedMIME,
	}
}
