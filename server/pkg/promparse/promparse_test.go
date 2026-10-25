package promparse

import (
	"testing"
)

func TestPromParse(t *testing.T) {
	input := `# HELP http_requests_total Total number of HTTP requests.
# TYPE http_requests_total counter
http_requests_total{method="post",code="200"} 1027 1395066363000
http_requests_total{method="post",code="400"} 3 1395066363000
http_requests_total{method="get",code="200"} 2000

simple_metric 42.5
zero_metric 0
negative_metric -5.5
`

	m := Parse(input)

	if !m.Has("http_requests_total") {
		t.Errorf("expected http_requests_total to exist")
	}

	if !m.Has("simple_metric") {
		t.Errorf("expected simple_metric to exist")
	}

	if m.Has("non_existent") {
		t.Errorf("expected non_existent to not exist")
	}

	if val := m.Float64("simple_metric"); val != 42.5 {
		t.Errorf("Float64 simple_metric = %v, want 42.5", val)
	}

	if val := m.Int("simple_metric"); val != 42 {
		t.Errorf("Int simple_metric = %v, want 42", val)
	}

	if val := m.Uint64("simple_metric"); val != 42 {
		t.Errorf("Uint64 simple_metric = %v, want 42", val)
	}

	// Negative should return 0 for unsigned
	if val := m.Uint64("negative_metric"); val != 0 {
		t.Errorf("Uint64 negative_metric = %v, want 0", val)
	}

	// Sum
	if sum := m.SumInt("http_requests_total"); sum != 3030 {
		t.Errorf("SumInt http_requests_total = %v, want 3030", sum)
	}

	if sum := m.SumUint64("http_requests_total"); sum != 3030 {
		t.Errorf("SumUint64 http_requests_total = %v, want 3030", sum)
	}

	// Label filters
	if val := m.Float64WithLabel("http_requests_total", "code", "400"); val != 3 {
		t.Errorf("Float64WithLabel code=400 = %v, want 3", val)
	}

	if val := m.Uint64WithLabel("http_requests_total", "method", "get"); val != 2000 {
		t.Errorf("Uint64WithLabel method=get = %v, want 2000", val)
	}

	if val := m.Float64WithLabel("http_requests_total", "code", "500"); val != 0 {
		t.Errorf("Float64WithLabel code=500 = %v, want 0", val)
	}
}

func TestParseLineEdgeCases(t *testing.T) {
	cases := []struct {
		line      string
		wantName  string
		wantValue string
	}{
		{"", "", ""},
		{"# comment", "", ""},
		{"malformed{open", "", ""},
		{"tab_separated\t100", "tab_separated", "100"},
		{"no_value", "", ""},
	}

	for _, c := range cases {
		m := Parse(c.line)
		if c.wantName != "" {
			if !m.Has(c.wantName) {
				t.Errorf("line %q: expected metric %q to exist", c.line, c.wantName)
			}
		}
	}
}
