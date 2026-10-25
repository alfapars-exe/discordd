package services

import (
	"strings"
	"testing"
)

func TestSearchMusicArgsBoundsProviderAndStopsOptionParsing(t *testing.T) {
	args := searchMusicArgs(`hello --exec "bad"`)
	joined := strings.Join(args, "\n")
	if !strings.Contains(joined, "--use-extractors\nYoutube.*") {
		t.Fatal("search must remain restricted to YouTube extractors")
	}
	if args[len(args)-2] != "--" || args[len(args)-1] != `ytsearch5:hello --exec "bad"` {
		t.Fatalf("query must be one positional argument after --: %#v", args[len(args)-2:])
	}
}
