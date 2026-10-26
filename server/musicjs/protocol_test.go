package musicjs

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
)

const fixtureJSON = `{"type":"player","player":"function fixture() {}","requests":[{"type":"n","challenges":["challenge"]}],"output_preprocessed":true}`
const fixtureResult = `{"type":"result","responses":[{"type":"result","data":{"challenge":"answer"}}]}`

func fixtureEnvelope(t *testing.T, payload []byte) []byte {
	t.Helper()
	file, err := os.Open("testdata/ejs-0.8.0-prefix.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	reader, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	prefix, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return append(append(prefix, payload...), []byte(envelopeSuffix)...)
}

func TestPinnedEnvelopeOnlyExtractsStrictData(t *testing.T) {
	envelope := fixtureEnvelope(t, []byte(fixtureJSON))
	payload, err := ExtractRequest(envelope)
	if err != nil || string(payload) != fixtureJSON {
		t.Fatalf("pinned envelope rejected: %v", err)
	}
	for _, index := range []int{0, 100, envelopePrefixBytes - 1, len(envelope) - 1} {
		changed := bytes.Clone(envelope)
		changed[index] ^= 1
		if _, err := ExtractRequest(changed); err == nil {
			t.Fatalf("accepted changed envelope byte%d", index)
		}
	}
	for _, payload := range []string{fixtureJSON + `;console.log("injected")`, strings.Replace(fixtureJSON, `"type":"player"`, `"type":"player","type":"player"`, 1), strings.Replace(fixtureJSON, `"output_preprocessed":true`, `"output_preprocessed":true,"script":"arbitrary code"`, 1)} {
		if _, err := ExtractRequest(fixtureEnvelope(t, []byte(payload))); err == nil {
			t.Fatal("accepted invalid JSON envelope")
		}
	}
	if _, err := ExtractRequest(make([]byte, MaxEnvelopeBytes+1)); err == nil {
		t.Fatal("accepted oversized envelope")
	}
}

func TestRequestSchemaBoundsAndDuplicateKeys(t *testing.T) {
	for _, payload := range []string{
		strings.Replace(fixtureJSON, `"player":"function fixture() {}"`, `"player":"first","player":"second"`, 1),
		strings.Replace(fixtureJSON, `"type":"n"`, `"type":"n","type":"sig"`, 1),
		strings.Replace(fixtureJSON, `"type":"n"`, `"type":"exec"`, 1),
		strings.Replace(fixtureJSON, `"output_preprocessed":true`, `"output_preprocessed":null`, 1),
		strings.Replace(fixtureJSON, `"type":"player"`, `"type":"preprocessed"`, 1),
		strings.Replace(fixtureJSON, `["challenge"]`, `[]`, 1),
		strings.Replace(fixtureJSON, `["challenge"]`, `[NaN]`, 1),
		fixtureJSON + ` {}`,
	} {
		if _, err := ParseRequest([]byte(payload)); err == nil {
			t.Fatal("invalid request accepted")
		}
	}
	request := Request{Type: "player", Player: strings.Repeat("p", MaxPlayerBytes+1), Requests: []Challenge{{Type: "n", Challenges: []string{"x"}}}}
	payload, _ := json.Marshal(request)
	if _, err := ParseRequest(payload); err == nil {
		t.Fatal("oversized player accepted")
	}
	request.Player = "player"
	request.Requests[0].Challenges = make([]string, 513)
	for i := range request.Requests[0].Challenges {
		request.Requests[0].Challenges[i] = "x"
	}
	payload, _ = json.Marshal(request)
	if _, err := ParseRequest(payload); err == nil {
		t.Fatal("too many challenges accepted")
	}
	if _, err := ParseRequest(bytes.Repeat([]byte{'x'}, MaxInputBytes+1)); ErrorCode(err) != "payload_too_large" {
		t.Fatal("input bound not enforced")
	}
}

func TestDenoArgumentsAndSafeDiagnostics(t *testing.T) {
	if !IsVersionArgs([]string{"--version"}) || !ValidRunArgs(denoRunArgs) {
		t.Fatal("expected pinned argv rejected")
	}
	for _, args := range [][]string{{"eval", "arbitrary"}, append(append([]string{}, denoRunArgs...), "--allow-net"), {"--version", "extra"}} {
		if ValidRunArgs(args) || IsVersionArgs(args) {
			t.Fatal("unexpected argv accepted")
		}
	}
	if strings.Contains(Diagnostic(&Error{Code: "secret-token"}), "secret") {
		t.Fatal("unsafe error disclosed")
	}
	if code, ok := DiagnosticCode("WARNING: wrapped ERROR: HICHAT_JS_COMPUTE:busy)"); !ok || code != "busy" {
		t.Fatal("wrapped compute code lost")
	}
	if _, ok := DiagnosticCode("HICHAT_JS_COMPUTE:busy_secret"); ok {
		t.Fatal("accepted unknown diagnostic code")
	}
}

func TestSolverResultMustMatchRequestedChallenges(t *testing.T) {
	request, err := ParseRequest([]byte(fixtureJSON))
	if err != nil {
		t.Fatal(err)
	}
	if err := validateResult([]byte(fixtureResult), request); err != nil {
		t.Fatal(err)
	}
	for _, response := range []string{`{"type":"error","error":"secret"}`, `{"type":"result","responses":[]}`, strings.Replace(fixtureResult, `"challenge":"answer"`, `"other":"answer"`, 1), strings.Replace(fixtureResult, `"challenge":"answer"`, `"challenge":"answer","challenge":"duplicate"`, 1)} {
		if validateResult([]byte(response), request) == nil {
			t.Fatal("invalid solver result accepted")
		}
	}
}
