package main

import (
	"bytes"
	"context"
	"github.com/argeinfina/hichat/musicjs"
	"strings"
	"testing"
)

func TestVersionAndArgumentRejectionNeedNoSocketOrCredentials(t *testing.T) {
	var out bytes.Buffer
	if err := run(context.Background(), []string{"--version"}, strings.NewReader(""), &out, ""); err != nil || out.String() != "deno 2.9.8\n" {
		t.Fatal("pinned version contract")
	}
	for _, args := range [][]string{{"run", "--allow-net", "-"}, {"eval", "secret"}, {"--version", "extra"}} {
		out.Reset()
		err := run(context.Background(), args, strings.NewReader("arbitrary"), &out, "")
		if musicjs.ErrorCode(err) != "invalid_request" || out.Len() != 0 {
			t.Fatal("unsupported execution accepted")
		}
	}
}
