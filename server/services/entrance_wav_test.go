package services

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
)

// entranceWavSpec describes a synthetic WAV fixture. Zero values mean
// "consistent default" for byteRate/blockAlign.
type entranceWavSpec struct {
	riff       string
	format     uint16
	channels   int
	rate       int
	bits       int
	blockAlign int
	byteRate   int
	dataLen    int // bytes of PCM written
	declared   int // data chunk size field; -1 = dataLen
	before     [][]byte
}

func entranceChunk(id string, body []byte) []byte {
	c := make([]byte, 8, 8+len(body)+1)
	copy(c[0:4], id)
	binary.LittleEndian.PutUint32(c[4:8], uint32(len(body)))
	c = append(c, body...)
	if len(body)%2 == 1 {
		c = append(c, 0)
	}
	return c
}

func buildEntranceWav(s entranceWavSpec) []byte {
	if s.riff == "" {
		s.riff = "RIFF"
	}
	if s.format == 0 {
		s.format = 1
	}
	if s.bits == 0 {
		s.bits = 16
	}
	if s.blockAlign == 0 {
		s.blockAlign = s.channels * s.bits / 8
	}
	if s.byteRate == 0 {
		s.byteRate = s.rate * s.blockAlign
	}
	fmtBody := make([]byte, 16)
	binary.LittleEndian.PutUint16(fmtBody[0:2], s.format)
	binary.LittleEndian.PutUint16(fmtBody[2:4], uint16(s.channels))
	binary.LittleEndian.PutUint32(fmtBody[4:8], uint32(s.rate))
	binary.LittleEndian.PutUint32(fmtBody[8:12], uint32(s.byteRate))
	binary.LittleEndian.PutUint16(fmtBody[12:14], uint16(s.blockAlign))
	binary.LittleEndian.PutUint16(fmtBody[14:16], uint16(s.bits))

	pcm := make([]byte, s.dataLen)
	for i := range pcm {
		pcm[i] = byte(i * 7)
	}
	var body bytes.Buffer
	body.WriteString("WAVE")
	for _, c := range s.before {
		body.Write(c)
	}
	body.Write(entranceChunk("fmt ", fmtBody))
	dataHdr := make([]byte, 8)
	copy(dataHdr[0:4], "data")
	declared := s.declared
	if declared < 0 {
		declared = s.dataLen
	}
	binary.LittleEndian.PutUint32(dataHdr[4:8], uint32(declared))
	body.Write(dataHdr)
	body.Write(pcm)

	out := make([]byte, 8, 8+body.Len())
	copy(out[0:4], s.riff)
	binary.LittleEndian.PutUint32(out[4:8], uint32(body.Len()))
	return append(out, body.Bytes()...)
}

// monoWav returns a valid mono 24 kHz 16-bit file of ms milliseconds.
func monoWav(ms int) []byte {
	return buildEntranceWav(entranceWavSpec{channels: 1, rate: 24000, dataLen: 24000 * 2 * ms / 1000, declared: -1})
}

func TestParsePCMWav_AcceptsMono24k1000ms(t *testing.T) {
	in := monoWav(1000)
	pcm, ch, rate, ms, err := ParsePCMWav(in)
	if err != nil {
		t.Fatalf("ParsePCMWav: %v", err)
	}
	if ch != 1 || rate != 24000 || ms != 1000 || len(pcm) != 48000 {
		t.Fatalf("got ch=%d rate=%d ms=%d pcm=%d, want 1/24000/1000/48000", ch, rate, ms, len(pcm))
	}
	out := EncodeCanonicalWav(pcm, ch, rate)
	if len(out) != 44+48000 {
		t.Fatalf("canonical length = %d, want %d", len(out), 44+48000)
	}
	// The canonical file round-trips to the same samples and format.
	pcm2, ch2, rate2, ms2, err := ParsePCMWav(out)
	if err != nil || ch2 != 1 || rate2 != 24000 || ms2 != 1000 || !bytes.Equal(pcm2, pcm) {
		t.Fatalf("canonical round trip mismatch: err=%v ch=%d rate=%d ms=%d", err, ch2, rate2, ms2)
	}
	// The input here was already canonical, so the bytes are identical too.
	if !bytes.Equal(out, in) {
		t.Error("canonical output differs from an already-canonical input")
	}
}

func TestParsePCMWav_AcceptsStereo48k100ms(t *testing.T) {
	in := buildEntranceWav(entranceWavSpec{channels: 2, rate: 48000, dataLen: 48000 * 4 / 10, declared: -1})
	_, ch, rate, ms, err := ParsePCMWav(in)
	if err != nil || ch != 2 || rate != 48000 || ms != 100 {
		t.Fatalf("got err=%v ch=%d rate=%d ms=%d, want stereo 48000 100ms", err, ch, rate, ms)
	}
}

func TestParsePCMWav_StripsListChunk(t *testing.T) {
	list := entranceChunk("LIST", []byte("INFOISFT\x05\x00\x00\x00evil\x00")) // odd-length body → pad byte
	in := buildEntranceWav(entranceWavSpec{channels: 1, rate: 24000, dataLen: 4800, declared: -1, before: [][]byte{list}})
	pcm, ch, rate, _, err := ParsePCMWav(in)
	if err != nil {
		t.Fatalf("ParsePCMWav with LIST chunk: %v", err)
	}
	out := EncodeCanonicalWav(pcm, ch, rate)
	if bytes.Contains(out, []byte("LIST")) || bytes.Contains(out, []byte("evil")) {
		t.Error("canonical output still contains the LIST chunk")
	}
	if len(out) != 44+4800 {
		t.Errorf("canonical length = %d, want %d", len(out), 44+4800)
	}
}

func TestParsePCMWav_Rejects(t *testing.T) {
	junk := entranceChunk("junk", []byte{1, 2, 3, 4})
	seventeen := make([][]byte, 16)
	for i := range seventeen {
		seventeen[i] = junk
	}
	// 16 junk chunks + fmt = 17 chunks before data.
	mp3 := append([]byte("ID3\x03\x00\x00\x00\x00\x00\x00"), bytes.Repeat([]byte{0xFF, 0xFB, 0x90, 0x64}, 300)...)

	cases := []struct {
		name string
		in   []byte
		want error
	}{
		{"99 ms", monoWav(99), models.ErrEntranceDurationInvalid},
		{"5001 ms", monoWav(5001), models.ErrEntranceDurationInvalid},
		{"8-bit", buildEntranceWav(entranceWavSpec{channels: 1, rate: 24000, bits: 8, dataLen: 24000, declared: -1}), models.ErrEntranceInvalidAudio},
		{"float format 3", buildEntranceWav(entranceWavSpec{format: 3, channels: 1, rate: 24000, dataLen: 48000, declared: -1}), models.ErrEntranceInvalidAudio},
		{"3 channels", buildEntranceWav(entranceWavSpec{channels: 3, rate: 24000, dataLen: 6 * 24000, declared: -1}), models.ErrEntranceInvalidAudio},
		{"96000 Hz", buildEntranceWav(entranceWavSpec{channels: 1, rate: 96000, dataLen: 2 * 96000, declared: -1}), models.ErrEntranceInvalidAudio},
		{"7999 Hz", buildEntranceWav(entranceWavSpec{channels: 1, rate: 7999, dataLen: 2 * 7999, declared: -1}), models.ErrEntranceInvalidAudio},
		{"inconsistent byteRate", buildEntranceWav(entranceWavSpec{channels: 1, rate: 24000, byteRate: 1, dataLen: 48000, declared: -1}), models.ErrEntranceInvalidAudio},
		{"inconsistent blockAlign", buildEntranceWav(entranceWavSpec{channels: 2, rate: 24000, blockAlign: 2, byteRate: 48000, dataLen: 48000, declared: -1}), models.ErrEntranceInvalidAudio},
		{"data larger than file", buildEntranceWav(entranceWavSpec{channels: 1, rate: 24000, dataLen: 48000, declared: 48002}), models.ErrEntranceInvalidAudio},
		{"data size 0xFFFFFFFF", buildEntranceWav(entranceWavSpec{channels: 1, rate: 24000, dataLen: 48000, declared: 0xFFFFFFFF}), models.ErrEntranceInvalidAudio},
		{"odd data bytes", buildEntranceWav(entranceWavSpec{channels: 1, rate: 24000, dataLen: 48001, declared: -1}), models.ErrEntranceInvalidAudio},
		{"17 chunks", buildEntranceWav(entranceWavSpec{channels: 1, rate: 24000, dataLen: 48000, declared: -1, before: seventeen}), models.ErrEntranceInvalidAudio},
		{"RIFX", buildEntranceWav(entranceWavSpec{riff: "RIFX", channels: 1, rate: 24000, dataLen: 48000, declared: -1}), models.ErrEntranceInvalidAudio},
		{"mp3 bytes", mp3, models.ErrEntranceInvalidAudio},
		{"0 frames", buildEntranceWav(entranceWavSpec{channels: 1, rate: 24000, dataLen: 0, declared: -1}), models.ErrEntranceInvalidAudio},
		{"empty", nil, models.ErrEntranceInvalidAudio},
		{"no data chunk", buildEntranceWav(entranceWavSpec{channels: 1, rate: 24000, dataLen: 0, declared: -1})[:36], models.ErrEntranceInvalidAudio},
	}
	for _, c := range cases {
		_, _, _, _, err := ParsePCMWav(c.in)
		if !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", c.name, err, c.want)
		}
	}
}

// TestParsePCMWav_NoPanicOnTruncationOrMutation is the fuzz-like table:
// every prefix of a valid file and a batch of seeded random byte flips must
// return (not panic).
func TestParsePCMWav_NoPanicOnTruncationOrMutation(t *testing.T) {
	list := entranceChunk("LIST", []byte("INFOabc"))
	valid := buildEntranceWav(entranceWavSpec{channels: 2, rate: 8000, dataLen: 3200, declared: -1, before: [][]byte{list}})
	for n := 0; n < len(valid); n++ {
		if _, _, _, _, err := ParsePCMWav(valid[:n]); err == nil && n < len(valid) {
			// A truncated prefix can only be accepted if it still ends on a
			// whole data chunk — never the case for these fixtures.
			t.Fatalf("prefix of %d bytes accepted", n)
		}
	}
	// Deterministic LCG (no randomness needed — just a reproducible spread
	// of mutations).
	state := uint32(88)
	next := func(n int) int {
		state = state*1664525 + 1013904223
		return int(state>>8) % n
	}
	for i := 0; i < 2000; i++ {
		m := append([]byte(nil), valid...)
		for j := 0; j < 1+next(6); j++ {
			pos := next(64) // header region, where the length fields live
			m[pos] = byte(next(256))
		}
		_, _, _, _, _ = ParsePCMWav(m)
	}
}
