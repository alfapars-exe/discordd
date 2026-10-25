package services

import (
	"bufio"
	"bytes"
	"io"
	"os"
	"runtime"
	"strconv"
	"strings"

	"github.com/argeinfina/hichat/musicworker"
)

const maxMusicWorkerCookieBytes = 1 << 20

func readMusicWorkerCookies(path string) ([]byte, error) {
	invalid := &musicworker.Error{Code: "tool_missing"}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxMusicWorkerCookieBytes || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
		return nil, invalid
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, invalid
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxMusicWorkerCookieBytes+1))
	if err != nil || len(data) > maxMusicWorkerCookieBytes {
		return nil, invalid
	}
	return filterMusicWorkerCookies(data)
}

func filterMusicWorkerCookies(data []byte) ([]byte, error) {
	invalid := &musicworker.Error{Code: "tool_missing"}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 4096), 64<<10)
	var result bytes.Buffer
	result.WriteString("# Netscape HTTP Cookie File\n")
	count := 0
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if strings.TrimSpace(line) == "" || (strings.HasPrefix(line, "#") && !strings.HasPrefix(line, "#HttpOnly_")) {
			continue
		}
		fields := strings.Split(strings.TrimPrefix(line, "#HttpOnly_"), "\t")
		if len(fields) != 7 {
			return nil, invalid
		}
		domain := strings.ToLower(strings.TrimPrefix(fields[0], "."))
		// No Google account, unrelated service, or arbitrary domain cookies are
		// copied to subprocesses. Exporting a whole browser jar is unnecessary.
		if domain != "youtube.com" && domain != "www.youtube.com" && domain != "m.youtube.com" && domain != "music.youtube.com" {
			continue
		}
		if (fields[1] != "TRUE" && fields[1] != "FALSE") || (fields[3] != "TRUE" && fields[3] != "FALSE") || !strings.HasPrefix(fields[2], "/") || fields[5] == "" {
			return nil, invalid
		}
		if _, err := strconv.ParseInt(fields[4], 10, 64); err != nil {
			return nil, invalid
		}
		for _, field := range fields {
			if strings.ContainsAny(field, "\x00\r\n") {
				return nil, invalid
			}
		}
		count++
		if count > 500 {
			return nil, invalid
		}
		result.WriteString(line)
		result.WriteByte('\n')
	}
	if scanner.Err() != nil || count == 0 {
		return nil, invalid
	}
	return result.Bytes(), nil
}
