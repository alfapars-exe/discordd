package musicjs

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	endpoint string
	token    string
	http     *http.Client
}

func NewClient(endpoint, token string) (*Client, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/" && u.Path != "/solve") || len(token) < 32 || len(token) > 512 || strings.ContainsAny(token, "\x00\r\n \t") {
		return nil, &Error{Code: "invalid_request"}
	}
	u.Path = "/solve"
	u.RawPath = ""
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext, TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 30 * time.Second, MaxResponseHeaderBytes: 16 << 10, MaxConnsPerHost: 1, MaxIdleConnsPerHost: 1}
	return &Client{endpoint: u.String(), token: token, http: &http.Client{Transport: transport, Timeout: 35 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (c *Client) solve(ctx context.Context, payload []byte, request Request) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, &Error{Code: "network"}
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set(ProtocolHeader, Protocol)
	req.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(req)
	if err != nil {
		return nil, &Error{Code: "network"}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, MaxOutputBytes+1))
	if err != nil {
		return nil, &Error{Code: "network"}
	}
	if len(data) > MaxOutputBytes {
		return nil, &Error{Code: "output_limit"}
	}
	if response.StatusCode != http.StatusOK {
		var result struct {
			Error string `json:"error"`
		}
		if len(data) <= 4096 && json.Unmarshal(data, &result) == nil && safeCode(result.Error) == result.Error {
			return nil, &Error{Code: result.Error}
		}
		switch response.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			return nil, &Error{Code: "unauthorized"}
		case http.StatusTooManyRequests:
			return nil, &Error{Code: "busy"}
		case http.StatusGatewayTimeout:
			return nil, &Error{Code: "timeout"}
		default:
			return nil, &Error{Code: "network"}
		}
	}
	if err := validateResult(data, request); err != nil {
		return nil, err
	}
	return data, nil
}

// Execute sends only validated challenge JSON to the job's private socket. No
// remote URL or credential is available to this subprocess-side function.
func Execute(ctx context.Context, socket string, payload []byte, output io.Writer) error {
	request, err := ParseRequest(payload)
	if err != nil {
		return err
	}
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, MaxResponseHeaderBytes: 16 << 10, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", socket)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 35 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://music-js/solve", bytes.NewReader(payload))
	if err != nil {
		return &Error{Code: "network"}
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := client.Do(req)
	if err != nil {
		return &Error{Code: "network"}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, MaxOutputBytes+1))
	if err != nil {
		return &Error{Code: "network"}
	}
	if len(data) > MaxOutputBytes {
		return &Error{Code: "output_limit"}
	}
	if response.StatusCode != http.StatusOK {
		var result struct {
			Error string `json:"error"`
		}
		if len(data) <= 4096 && json.Unmarshal(data, &result) == nil {
			return &Error{Code: safeCode(result.Error)}
		}
		return &Error{Code: "network"}
	}
	if err := validateResult(data, request); err != nil {
		return err
	}
	n, err := output.Write(data)
	if err == nil && n != len(data) {
		err = io.ErrShortWrite
	}
	return err
}
