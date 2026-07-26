// Package pkg — content-type sniffing for uploads.
//
// http.DetectContentType inspects the first 512 bytes of a file and
// returns the MIME the bytes actually look like, regardless of what the
// client claimed in the multipart Content-Type header. The client header
// is fully attacker-controlled, so nothing security-relevant may ever
// trust it.
//
// Since all file types became uploadable, the sniffed MIME is RECORDED
// (display metadata) rather than enforced — there is no upload allowlist
// anymore. The security boundary moved to serve time: the download handler
// re-sniffs the bytes and forces non-displayable types to
// application/octet-stream + Content-Disposition: attachment, so a
// hostile HTML/JS/SVG upload can never execute on the app origin.
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
	replayed := io.MultiReader(bytes.NewReader(buf[:n]), src)
	return NormalizeMIME(sniffed), replayed, nil
}

// NormalizeMIME strips any "; charset=..." trailer and lowercases, so
// callers can compare against plain "image/png"-style values.
func NormalizeMIME(mime string) string {
	if semi := strings.IndexByte(mime, ';'); semi >= 0 {
		mime = strings.TrimSpace(mime[:semi])
	}
	return strings.ToLower(mime)
}

// extensionMIME is the controlled fallback map for filename-based
// classification. Kept small and explicit, and consulted ONLY when the
// sniff came back generic (see RefineMIME) — so a name can never override
// what the bytes actually are, and active content (svg/html/js/xml) is
// deliberately absent: nothing may label those inline-displayable.
//
// The real-world need: DetectContentType returns "application/ogg" for
// OGG containers (not "audio/ogg") and "application/octet-stream" for raw
// MP3s without an ID3 tag; without the fallback those recorded as opaque
// blobs and lost their inline players.
var extensionMIME = map[string]string{
	"jpg":  "image/jpeg",
	"jpeg": "image/jpeg",
	"png":  "image/png",
	"gif":  "image/gif",
	"webp": "image/webp",
	"bmp":  "image/bmp",
	"avif": "image/avif",
	"mp4":  "video/mp4",
	"webm": "video/webm",
	"mp3":  "audio/mpeg",
	"ogg":  "audio/ogg",
	"wav":  "audio/wave",
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

// RefineMIME upgrades a GENERIC sniff result using the controlled extension
// map. Only "application/octet-stream" and "application/ogg" are refined;
// any specific sniffed type always wins — the bytes are the source of
// truth, so a .png full of HTML stays text/html no matter what the name
// claims. Never errors: with no upload allowlist there is nothing to
// reject, only a best-effort type to record.
func RefineMIME(sniffed, filename string) string {
	if sniffed != "application/octet-stream" && sniffed != "application/ogg" {
		return sniffed
	}
	if candidate, ok := extensionMIME[extFromName(filename)]; ok {
		return candidate
	}
	return sniffed
}
