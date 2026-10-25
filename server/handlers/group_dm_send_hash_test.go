package handlers

import (
	"bytes"
	"mime/multipart"
	"net/http/httptest"
	"testing"
)

func TestGroupSendRequestHashBindsOrderedFileBytes(t *testing.T) {
	req := operationPayload("hash-request-0001")
	hash := func(data []string, limit int64) (string, error) {
		t.Helper()
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		for _, value := range data {
			part, err := writer.CreateFormFile("files", "same.bin")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = part.Write([]byte(value)); err != nil {
				t.Fatal(err)
			}
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest("POST", "/", &body)
		r.Header.Set("Content-Type", writer.FormDataContentType())
		if err := r.ParseMultipartForm(1024); err != nil {
			t.Fatal(err)
		}
		defer func() { _ = r.MultipartForm.RemoveAll() }()
		return groupSendRequestHash(&req, r.MultipartForm.File["files"], limit)
	}
	original, err := hash([]string{"alpha", "bravo"}, 1024)
	if err != nil {
		t.Fatal(err)
	}
	repeat, err := hash([]string{"alpha", "bravo"}, 1024)
	if err != nil || original != repeat {
		t.Fatal("random multipart boundary changed logical digest", err)
	}
	swapped, _ := hash([]string{"bravo", "alpha"}, 1024)
	changed, _ := hash([]string{"alpha", "other"}, 1024)
	if original == swapped || original == changed {
		t.Fatal("file order/content not bound")
	}
	if _, err = hash([]string{"oversized"}, 2); err == nil {
		t.Fatal("hash reads beyond per-file size limit")
	}
	old := *req.Ciphertext
	newCipher := "changed"
	req.Ciphertext = &newCipher
	fresh, _ := hash([]string{"alpha", "bravo"}, 1024)
	if fresh == original {
		t.Fatal("ciphertext not bound")
	}
	req.Ciphertext = &old
}
