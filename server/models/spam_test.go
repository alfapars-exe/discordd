package models

import "testing"

func TestSpamReferenceValidation(t *testing.T) {
	good := SpamInboxEntry{SourceKind: "dm", ChannelID: "private", MessageID: "message", Revision: "original", Reasons: []string{"credential-link"}}
	if err := good.Validate(true); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*SpamInboxEntry){
		func(e *SpamInboxEntry) { e.ChannelID = "" }, func(e *SpamInboxEntry) { e.SourceKind = "foreign" }, func(e *SpamInboxEntry) { e.Revision = "invalid" },
		func(e *SpamInboxEntry) { e.Reasons = []string{"plaintext"} }, func(e *SpamInboxEntry) { e.Reasons = []string{"credential-link", "credential-link"} },
	} {
		e := good
		mutate(&e)
		if e.Validate(true) == nil {
			t.Fatalf("invalid reference accepted: %+v", e)
		}
	}
}
