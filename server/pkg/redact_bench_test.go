package pkg

import "testing"

func BenchmarkRedactOrdinaryURL(b *testing.B) {
	for b.Loop() {
		RedactSecrets("https://example.test/api/messages/history?channel=example&limit=50")
	}
}
