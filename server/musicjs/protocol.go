// Package musicjs relays only the pinned yt-dlp EJS challenge data. It never
// accepts executable arguments or forwards caller-supplied JavaScript wrappers.
package musicjs

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode/utf8"
)

const (
	Protocol             = "ejs-0.8.0-deno-2.9.8-v1"
	ProtocolHeader       = "X-HiChat-JS-Protocol"
	SocketEnvironment    = "HICHAT_MUSIC_JS_SOCKET"
	MaxInputBytes        = 8 << 20
	MaxOutputBytes       = 1 << 20
	MaxPlayerBytes       = 6 << 20
	envelopePrefixBytes  = 158603
	envelopePrefixSHA256 = "bf7d7bf9f8aa746ee62ebd278c38b0959af3381c0d9048be5da4a9a7eeb12a5c"
	envelopeSuffix       = ")));\n        "
	MaxEnvelopeBytes     = MaxInputBytes + envelopePrefixBytes + len(envelopeSuffix)
	diagnosticPrefix     = "HICHAT_JS_COMPUTE:"
)

type Error struct{ Code string }

func (e *Error) Error() string { return "music compute: " + safeCode(e.Code) }
func safeCode(code string) string {
	switch code {
	case "network", "unauthorized", "protocol_mismatch", "invalid_request", "payload_too_large", "busy", "timeout", "output_limit", "solver_failed", "unavailable":
		return code
	default:
		return "solver_failed"
	}
}

func ErrorCode(err error) string {
	var typed *Error
	if errors.As(err, &typed) {
		return safeCode(typed.Code)
	}
	return "network"
}
func Diagnostic(err error) string { return "ERROR: " + diagnosticPrefix + ErrorCode(err) }

// DiagnosticCode recognizes only the shim's fixed vocabulary, including when
// yt-dlp embeds that line inside its own provider warning.
func DiagnosticCode(line string) (string, bool) {
	_, tail, ok := strings.Cut(line, diagnosticPrefix)
	if !ok {
		return "", false
	}
	end := 0
	for end < len(tail) && ((tail[end] >= 'a' && tail[end] <= 'z') || tail[end] == '_') {
		end++
	}
	code := tail[:end]
	if safeCode(code) != code {
		return "", false
	}
	return code, true
}

type Request struct {
	Type               string      `json:"type"`
	Player             string      `json:"player"`
	Requests           []Challenge `json:"requests"`
	OutputPreprocessed bool        `json:"output_preprocessed"`
}
type Challenge struct {
	Type       string   `json:"type"`
	Challenges []string `json:"challenges"`
}

var denoRunArgs = []string{"run", "--ext=js", "--no-code-cache", "--no-prompt", "--no-remote", "--no-lock", "--node-modules-dir=none", "--no-config", "--no-npm", "--cached-only", "-"}

func IsVersionArgs(args []string) bool { return len(args) == 1 && args[0] == "--version" }
func ValidRunArgs(args []string) bool {
	if len(args) != len(denoRunArgs) {
		return false
	}
	for i := range args {
		if args[i] != denoRunArgs[i] {
			return false
		}
	}
	return true
}

// ExtractRequest accepts the exact wrapper emitted by pinned yt-dlp 2026.10.21
// with bundled EJS 0.8.0. Only its strictly decoded JSON payload leaves Oracle.
func ExtractRequest(envelope []byte) ([]byte, error) {
	if len(envelope) > MaxEnvelopeBytes || len(envelope) < envelopePrefixBytes+len(envelopeSuffix) || !bytes.HasSuffix(envelope, []byte(envelopeSuffix)) {
		return nil, &Error{Code: "invalid_request"}
	}
	hash := sha256.Sum256(envelope[:envelopePrefixBytes])
	if hex.EncodeToString(hash[:]) != envelopePrefixSHA256 {
		return nil, &Error{Code: "protocol_mismatch"}
	}
	payload := envelope[envelopePrefixBytes : len(envelope)-len(envelopeSuffix)]
	if _, err := ParseRequest(payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func ParseRequest(data []byte) (Request, error) {
	invalid := &Error{Code: "invalid_request"}
	if len(data) > MaxInputBytes {
		return Request{}, &Error{Code: "payload_too_large"}
	}
	value, err := strictJSON(data)
	if err != nil {
		return Request{}, invalid
	}
	root, ok := value.(map[string]any)
	if !ok || len(root) != 4 {
		return Request{}, invalid
	}
	kind, kok := root["type"].(string)
	player, pok := root["player"].(string)
	groups, gok := root["requests"].([]any)
	preprocessed, bok := root["output_preprocessed"].(bool)
	if !kok || kind != "player" || !pok || player == "" || len(player) > MaxPlayerBytes || !gok || len(groups) < 1 || len(groups) > 16 || !bok {
		return Request{}, invalid
	}
	request := Request{Type: kind, Player: player, OutputPreprocessed: preprocessed}
	total := 0
	for _, group := range groups {
		object, ok := group.(map[string]any)
		if !ok || len(object) != 2 {
			return Request{}, invalid
		}
		typ, tok := object["type"].(string)
		values, vok := object["challenges"].([]any)
		if !tok || (typ != "n" && typ != "sig") || !vok || len(values) == 0 {
			return Request{}, invalid
		}
		challenge := Challenge{Type: typ}
		for _, value := range values {
			value, ok := value.(string)
			if !ok || value == "" || len(value) > 16<<10 {
				return Request{}, invalid
			}
			challenge.Challenges = append(challenge.Challenges, value)
			total++
			if total > 512 {
				return Request{}, invalid
			}
		}
		request.Requests = append(request.Requests, challenge)
	}
	return request, nil
}

func validateResult(data []byte, request Request) error {
	if len(data) > MaxOutputBytes {
		return &Error{Code: "output_limit"}
	}
	value, err := strictJSON(data)
	if err != nil {
		return &Error{Code: "solver_failed"}
	}
	root, ok := value.(map[string]any)
	if !ok || len(root) != 2 || root["type"] != "result" {
		return &Error{Code: "solver_failed"}
	}
	responses, ok := root["responses"].([]any)
	if !ok || len(responses) != len(request.Requests) {
		return &Error{Code: "solver_failed"}
	}
	for i, response := range responses {
		object, ok := response.(map[string]any)
		if !ok || len(object) != 2 || object["type"] != "result" {
			return &Error{Code: "solver_failed"}
		}
		data, ok := object["data"].(map[string]any)
		if !ok {
			return &Error{Code: "solver_failed"}
		}
		unique := make(map[string]struct{}, len(request.Requests[i].Challenges))
		for _, challenge := range request.Requests[i].Challenges {
			unique[challenge] = struct{}{}
			if _, ok := data[challenge].(string); !ok {
				return &Error{Code: "solver_failed"}
			}
		}
		if len(data) != len(unique) {
			return &Error{Code: "solver_failed"}
		}
	}
	return nil
}

func strictJSON(data []byte) (any, error) {
	if !utf8.Valid(data) {
		return nil, errors.New("invalid JSON")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	value, err := decodeValue(decoder, 0)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing JSON")
	}
	return value, nil
}

func decodeValue(decoder *json.Decoder, depth int) (any, error) {
	if depth > 8 {
		return nil, errors.New("JSON nesting")
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch token {
	case json.Delim('{'):
		object := make(map[string]any)
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			name, ok := key.(string)
			if !ok {
				return nil, errors.New("JSON key")
			}
			if _, exists := object[name]; exists {
				return nil, errors.New("duplicate JSON key")
			}
			value, err := decodeValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			object[name] = value
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return nil, errors.New("JSON object")
		}
		return object, nil
	case json.Delim('['):
		array := []any{}
		for decoder.More() {
			value, err := decodeValue(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			array = append(array, value)
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return nil, errors.New("JSON array")
		}
		return array, nil
	default:
		if _, ok := token.(json.Delim); ok {
			return nil, errors.New("JSON delimiter")
		}
		return token, nil
	}
}
