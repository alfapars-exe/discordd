package pkg

import (
	"bytes"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
)

// filePart describes one file to attach to a test multipart body.
type filePart struct {
	field    string
	filename string
	content  []byte
}

// buildMultipartRequest writes files and values into a multipart/form-data
// body and wraps it in an httptest request ready for
// LimitedParseMultipartFormN.
func buildMultipartRequest(t *testing.T, files []filePart, values map[string]string) *http.Request {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for _, f := range files {
		fw, err := mw.CreateFormFile(f.field, f.filename)
		if err != nil {
			t.Fatalf("CreateFormFile(%s): %v", f.field, err)
		}
		if _, err := fw.Write(f.content); err != nil {
			t.Fatalf("write file content for %s: %v", f.field, err)
		}
	}
	for k, v := range values {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatalf("WriteField(%s): %v", k, err)
		}
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

func TestLimitedParseMultipartFormN_atLimit_singleField_accepted(t *testing.T) {
	files := []filePart{
		{field: "files", filename: "a.txt", content: []byte("a")},
		{field: "files", filename: "b.txt", content: []byte("b")},
		{field: "files", filename: "c.txt", content: []byte("c")},
	}
	req := buildMultipartRequest(t, files, nil)
	rec := httptest.NewRecorder()

	if err := LimitedParseMultipartFormN(rec, req, 1<<20, 3); err != nil {
		t.Fatalf("n=3 with exactly 3 file parts should be accepted, got %v", err)
	}
}

func TestLimitedParseMultipartFormN_overLimit_singleField_rejectedAndCleanedUp(t *testing.T) {
	// maxBytesPerFile=1 forces every part (each well over 1 byte) to spill
	// to a disk tempfile, so this test also proves the early-cleanup path
	// (RemoveAll) actually removes the tempfile rather than just clearing
	// the in-memory map.
	files := []filePart{
		{field: "files", filename: "a.bin", content: bytes.Repeat([]byte("a"), 50)},
		{field: "files", filename: "b.bin", content: bytes.Repeat([]byte("b"), 50)},
		{field: "files", filename: "c.bin", content: bytes.Repeat([]byte("c"), 50)},
		{field: "files", filename: "d.bin", content: bytes.Repeat([]byte("d"), 50)},
	}
	req := buildMultipartRequest(t, files, nil)
	rec := httptest.NewRecorder()

	err := LimitedParseMultipartFormN(rec, req, 1, 3)
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("n=3 with 4 file parts should wrap ErrBadRequest, got %v", err)
	}

	fhs := req.MultipartForm.File["files"]
	if len(fhs) != 4 {
		t.Fatalf("expected 4 parsed file headers still referenced, got %d", len(fhs))
	}
	for _, fh := range fhs {
		if _, openErr := fh.Open(); openErr == nil {
			t.Errorf("Open() on %s succeeded after RemoveAll — tempfile was not cleaned up", fh.Filename)
		}
	}
}

func TestLimitedParseMultipartFormN_overLimit_acrossDifferentFieldNames_rejected(t *testing.T) {
	// The rule is a total across ALL field names, not per-field — a caller
	// spreading files across "a" and "b" is still bounded by n in aggregate.
	files := []filePart{
		{field: "a", filename: "1.txt", content: []byte("x")},
		{field: "a", filename: "2.txt", content: []byte("x")},
		{field: "b", filename: "3.txt", content: []byte("x")},
		{field: "b", filename: "4.txt", content: []byte("x")},
	}
	req := buildMultipartRequest(t, files, nil)
	rec := httptest.NewRecorder()

	err := LimitedParseMultipartFormN(rec, req, 1<<20, 3)
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("n=3 with 2+2 file parts across two fields should wrap ErrBadRequest, got %v", err)
	}
}

func TestLimitedParseMultipartFormN_nonFileValueFields_notCounted(t *testing.T) {
	files := []filePart{{field: "file", filename: "only.txt", content: []byte("x")}}
	values := map[string]string{
		"reason":      "spam",
		"description": "long text",
		"foo":         "1",
		"bar":         "2",
		"baz":         "3",
	}
	req := buildMultipartRequest(t, files, values)
	rec := httptest.NewRecorder()

	if err := LimitedParseMultipartFormN(rec, req, 1<<20, 1); err != nil {
		t.Fatalf("n=1 with 1 file + 5 non-file value fields should be accepted, got %v", err)
	}
}

func TestLimitedParseMultipartFormN_zeroN_clampsToOne(t *testing.T) {
	files := []filePart{
		{field: "files", filename: "a.txt", content: []byte("a")},
		{field: "files", filename: "b.txt", content: []byte("b")},
	}
	req := buildMultipartRequest(t, files, nil)
	rec := httptest.NewRecorder()

	err := LimitedParseMultipartFormN(rec, req, 1<<20, 0)
	if !errors.Is(err, ErrBadRequest) {
		t.Fatalf("n=0 should clamp to 1 and reject 2 file parts, got %v", err)
	}
}

func TestLimitedParseMultipartFormN_byteCapStillEnforced(t *testing.T) {
	// Regression pin: the new file-count check must not shadow the
	// pre-existing body-size cap. A body larger than
	// maxBytesPerFile*n + overhead must still fail with the
	// http.MaxBytesReader sentinel, not the count-check error.
	const maxBytesPerFile = int64(100)
	const n = 1
	totalCap := maxBytesPerFile*int64(n) + multipartHeaderOverhead

	files := []filePart{
		{field: "file", filename: "big.bin", content: bytes.Repeat([]byte("A"), int(totalCap)+2048)},
	}
	req := buildMultipartRequest(t, files, nil)
	rec := httptest.NewRecorder()

	err := LimitedParseMultipartFormN(rec, req, maxBytesPerFile, n)
	if err == nil {
		t.Fatal("body exceeding totalCap should fail, got nil error")
	}
	var mbe *http.MaxBytesError
	if !errors.As(err, &mbe) {
		t.Fatalf("expected *http.MaxBytesError, got %T: %v", err, err)
	}
}
