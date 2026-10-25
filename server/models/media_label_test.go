package models

import (
	"strings"
	"testing"
)

func TestMediaLabelValidation(t *testing.T) {
	good := MediaLabel{SourceKind: "dm", ChannelID: "dm", MessageID: "m", Revision: "original", Fingerprint: strings.Repeat("a", 64), Label: "sexual"}
	for _, label := range []string{"ordinary", "sexual", "disturbing", "both"} {
		entry := good
		entry.Label = label
		if err := entry.Validate(true); err != nil {
			t.Fatal(err)
		}
	}
	for _, change := range []func(*MediaLabel){func(e *MediaLabel) { e.SourceKind = "foreign" }, func(e *MediaLabel) { e.Fingerprint = "hash" }, func(e *MediaLabel) { e.Fingerprint = strings.Repeat("A", 64) }, func(e *MediaLabel) { e.Label = "safe-by-ai" }, func(e *MediaLabel) { e.Revision = "invalid" }, func(e *MediaLabel) { e.ChannelID = "" }} {
		entry := good
		change(&entry)
		if entry.Validate(true) == nil {
			t.Fatalf("accepted invalid annotation %+v", entry)
		}
	}
	var absent *MediaLabel
	if absent.Validate(true) == nil {
		t.Fatal("accepted nil")
	}
	for _, version := range []string{"", "legacy", strings.Repeat("a", 32)} {
		entry := good
		entry.ExpectedVersion = &version
		if err := entry.Validate(true); err != nil {
			t.Fatal(err)
		}
	}
	for _, version := range []string{"null", strings.Repeat("A", 32), strings.Repeat("a", 31), strings.Repeat("a", 64)} {
		entry := good
		entry.ExpectedVersion = &version
		if entry.Validate(true) == nil {
			t.Fatalf("invalid version %q", version)
		}
	}
}
