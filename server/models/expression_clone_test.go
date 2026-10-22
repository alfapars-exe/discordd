package models

import (
	"errors"
	"testing"
)

func TestCloneExpressionRequest_Validate(t *testing.T) {
	for _, id := range []string{"", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "../../etc/passwd"} {
		r := &CloneExpressionRequest{SourceID: id}
		if err := r.Validate(); !errors.Is(err, ErrExpressionSourceInvalid) {
			t.Errorf("source_id %q: err = %v, want ErrExpressionSourceInvalid", id, err)
		}
	}
	r := &CloneExpressionRequest{SourceID: "0123456789abcdef"}
	if err := r.Validate(); err != nil {
		t.Errorf("valid source_id: %v", err)
	}
	name := " yeni_ad "
	r = &CloneExpressionRequest{SourceID: "0123456789abcdef", Name: &name}
	if err := r.Validate(); err != nil || *r.Name != "yeni_ad" {
		t.Errorf("name override: %v, %v", r.Name, err)
	}
	blank := "  "
	r = &CloneExpressionRequest{SourceID: "0123456789abcdef", Name: &blank}
	if err := r.Validate(); err != nil || r.Name != nil {
		t.Errorf("blank name must mean keep the source's: %v, %v", r.Name, err)
	}
	bad := "Bad Name"
	r = &CloneExpressionRequest{SourceID: "0123456789abcdef", Name: &bad}
	if err := r.Validate(); !errors.Is(err, ErrExpressionNameInvalid) {
		t.Errorf("bad name override: %v", err)
	}
}
