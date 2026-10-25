// Package services — entrance_wav.go: strict PCM WAV parsing for entrance
// sound uploads.
//
// The server measures every clip itself (never trusting a client-declared
// duration) and writes back a canonical file: a 44-byte header plus the PCM
// samples only, so metadata chunks (LIST, id3, ...) and any trailing bytes
// never reach disk. All length/offset arithmetic runs in int64 against the
// real buffer length, so a hostile uint32 chunk size cannot overflow or
// index past the input.
package services

import (
	"encoding/binary"

	"github.com/argeinfina/hichat/models"
)

const (
	wavHeaderLen      = 44
	wavMaxChunks      = 16
	wavMinSampleRate  = 8000
	wavMaxSampleRate  = 48000
	wavBitsPerSample  = 16
	wavFormatPCM      = 1
	wavFmtChunkMinLen = 16
)

// ParsePCMWav validates b as a RIFF/WAVE file holding 16-bit integer PCM
// (1-2 channels, 8000-48000 Hz) and returns the raw sample bytes, the format
// and the measured duration. At most 16 chunks are scanned before both
// "fmt " and "data" must have been seen. The data chunk must lie within b
// and be a whole number of frames. Structural problems return
// models.ErrEntranceInvalidAudio; a well-formed file outside 100-5000 ms
// returns models.ErrEntranceDurationInvalid.
func ParsePCMWav(b []byte) (pcm []byte, channels, sampleRate, durationMs int, err error) {
	total := int64(len(b))
	if total < 12 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return nil, 0, 0, 0, models.ErrEntranceInvalidAudio
	}

	var (
		haveFmt, haveData bool
		blockAlign        int
		dataStart         int64
		dataLen           int64
	)
	off := int64(12)
	for chunks := 0; !haveFmt || !haveData; chunks++ {
		if chunks >= wavMaxChunks || off+8 > total {
			return nil, 0, 0, 0, models.ErrEntranceInvalidAudio
		}
		id := string(b[off : off+4])
		size := int64(binary.LittleEndian.Uint32(b[off+4 : off+8]))
		body := off + 8
		end := body + size
		if end > total {
			return nil, 0, 0, 0, models.ErrEntranceInvalidAudio
		}

		switch id {
		case "fmt ":
			if haveFmt || size < wavFmtChunkMinLen {
				return nil, 0, 0, 0, models.ErrEntranceInvalidAudio
			}
			f := b[body:end]
			format := binary.LittleEndian.Uint16(f[0:2])
			ch := int(binary.LittleEndian.Uint16(f[2:4]))
			rate := int64(binary.LittleEndian.Uint32(f[4:8]))
			byteRate := int64(binary.LittleEndian.Uint32(f[8:12]))
			align := int(binary.LittleEndian.Uint16(f[12:14]))
			bits := int(binary.LittleEndian.Uint16(f[14:16]))
			if format != wavFormatPCM || ch < 1 || ch > 2 ||
				rate < wavMinSampleRate || rate > wavMaxSampleRate || bits != wavBitsPerSample ||
				align != ch*(wavBitsPerSample/8) || byteRate != rate*int64(align) {
				return nil, 0, 0, 0, models.ErrEntranceInvalidAudio
			}
			haveFmt = true
			channels, sampleRate, blockAlign = ch, int(rate), align
		case "data":
			if haveData {
				return nil, 0, 0, 0, models.ErrEntranceInvalidAudio
			}
			haveData = true
			dataStart, dataLen = body, size
		}

		// RIFF chunks are word-aligned: an odd-sized chunk is followed by one
		// pad byte (which may be missing at the very end of the file).
		off = end + size%2
	}

	if dataLen == 0 || dataLen%int64(blockAlign) != 0 {
		return nil, 0, 0, 0, models.ErrEntranceInvalidAudio
	}
	frames := dataLen / int64(blockAlign)
	ms := frames * 1000 / int64(sampleRate)
	if ms < models.EntranceMinDurationMs || ms > models.EntranceMaxDurationMs {
		return nil, 0, 0, 0, models.ErrEntranceDurationInvalid
	}
	return b[dataStart : dataStart+dataLen], channels, sampleRate, int(ms), nil
}

// EncodeCanonicalWav builds a 44-byte-header 16-bit PCM WAV around pcm.
// pcm must already be whole frames (ParsePCMWav guarantees it).
func EncodeCanonicalWav(pcm []byte, channels, sampleRate int) []byte {
	blockAlign := channels * (wavBitsPerSample / 8)
	out := make([]byte, wavHeaderLen+len(pcm))
	copy(out[0:4], "RIFF")
	binary.LittleEndian.PutUint32(out[4:8], uint32(36+len(pcm))) // #nosec G115 -- pcm ≤ 1 MiB
	copy(out[8:12], "WAVE")
	copy(out[12:16], "fmt ")
	binary.LittleEndian.PutUint32(out[16:20], wavFmtChunkMinLen)
	binary.LittleEndian.PutUint16(out[20:22], wavFormatPCM)
	binary.LittleEndian.PutUint16(out[22:24], uint16(channels))              // #nosec G115 -- 1 or 2
	binary.LittleEndian.PutUint32(out[24:28], uint32(sampleRate))            // #nosec G115 -- ≤ 48000
	binary.LittleEndian.PutUint32(out[28:32], uint32(sampleRate*blockAlign)) // #nosec G115 -- ≤ 192000
	binary.LittleEndian.PutUint16(out[32:34], uint16(blockAlign))            // #nosec G115 -- 2 or 4
	binary.LittleEndian.PutUint16(out[34:36], wavBitsPerSample)
	copy(out[36:40], "data")
	binary.LittleEndian.PutUint32(out[40:44], uint32(len(pcm))) // #nosec G115 -- pcm ≤ 1 MiB
	copy(out[wavHeaderLen:], pcm)
	return out
}
