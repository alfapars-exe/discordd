#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cstdint>
#include <cstdlib>
#include <cwchar>
#include <iostream>
#include <string>
#include <vector>

namespace {

constexpr size_t kMaxPathChars = 1024;
constexpr DWORD kSampleIntervalMs = 500;
constexpr LONG kMaxCoordinateMagnitude = 32768;

struct Sample {
  bool available = false;
  std::wstring executablePath;
  RECT rect{};
};

bool WideToUtf8(const std::wstring& value, std::string* result) {
  if (value.empty() || value.size() > kMaxPathChars) return false;
  const int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (required <= 0 || required > static_cast<int>(kMaxPathChars * 4)) return false;
  result->resize(static_cast<size_t>(required));
  return WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), result->data(), required, nullptr, nullptr) == required;
}

std::string EscapeJsonString(const std::string& value) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string escaped;
  escaped.reserve(value.size() + 2);
  escaped.push_back('"');
  for (const unsigned char ch : value) {
    switch (ch) {
      case '"': escaped += "\\\""; break;
      case '\\': escaped += "\\\\"; break;
      case '\b': escaped += "\\b"; break;
      case '\f': escaped += "\\f"; break;
      case '\n': escaped += "\\n"; break;
      case '\r': escaped += "\\r"; break;
      case '\t': escaped += "\\t"; break;
      default:
        if (ch < 0x20) {
          escaped += "\\u00";
          escaped.push_back(kHex[(ch >> 4) & 0x0f]);
          escaped.push_back(kHex[ch & 0x0f]);
        } else {
          escaped.push_back(static_cast<char>(ch));
        }
    }
  }
  escaped.push_back('"');
  return escaped;
}

void WriteUnavailable() {
  std::cout << "{\"version\":1,\"available\":false,\"executablePath\":null,\"rect\":null}\n";
  std::cout.flush();
}

bool IsBoundedRect(const RECT& rect) {
  const std::int64_t width = static_cast<std::int64_t>(rect.right) - rect.left;
  const std::int64_t height = static_cast<std::int64_t>(rect.bottom) - rect.top;
  return width > 0 && height > 0 && width <= kMaxCoordinateMagnitude && height <= kMaxCoordinateMagnitude
      && rect.left >= -kMaxCoordinateMagnitude && rect.left <= kMaxCoordinateMagnitude
      && rect.top >= -kMaxCoordinateMagnitude && rect.top <= kMaxCoordinateMagnitude
      && rect.right >= -kMaxCoordinateMagnitude && rect.right <= kMaxCoordinateMagnitude
      && rect.bottom >= -kMaxCoordinateMagnitude && rect.bottom <= kMaxCoordinateMagnitude;
}

Sample ReadForegroundWindow(bool dpiAware) {
  Sample sample;
  if (!dpiAware) return sample;

  const HWND foreground = GetForegroundWindow();
  if (!foreground || !IsWindow(foreground) || !IsWindowVisible(foreground) || IsIconic(foreground)) return sample;

  DWORD processId = 0;
  if (GetWindowThreadProcessId(foreground, &processId) == 0 || processId == 0) return sample;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, processId);
  if (!process) return sample;

  std::vector<wchar_t> path(kMaxPathChars + 1, L'\0');
  DWORD pathChars = static_cast<DWORD>(path.size());
  const BOOL pathRead = QueryFullProcessImageNameW(process, 0, path.data(), &pathChars);
  const DWORD processState = WaitForSingleObject(process, 0);

  RECT client{};
  POINT topLeft{0, 0};
  POINT bottomRight{0, 0};
  const BOOL clientRead = GetClientRect(foreground, &client);
  if (clientRead) {
    topLeft = POINT{client.left, client.top};
    bottomRight = POINT{client.right, client.bottom};
  }
  const BOOL pointsRead = clientRead && ClientToScreen(foreground, &topLeft)
      && ClientToScreen(foreground, &bottomRight);
  CloseHandle(process);

  if (!pathRead || pathChars == 0 || pathChars > kMaxPathChars || processState != WAIT_TIMEOUT
      || !pointsRead || GetForegroundWindow() != foreground) return sample;

  DWORD currentProcessId = 0;
  if (GetWindowThreadProcessId(foreground, &currentProcessId) == 0 || currentProcessId != processId) return sample;

  sample.rect = RECT{topLeft.x, topLeft.y, bottomRight.x, bottomRight.y};
  if (!IsBoundedRect(sample.rect)) return Sample{};
  sample.executablePath.assign(path.data(), pathChars);
  sample.available = true;
  return sample;
}

void WriteSample(const Sample& sample) {
  if (!sample.available) {
    WriteUnavailable();
    return;
  }
  std::string utf8Path;
  if (!WideToUtf8(sample.executablePath, &utf8Path)) {
    WriteUnavailable();
    return;
  }
  std::cout << "{\"version\":1,\"available\":true,\"executablePath\":"
            << EscapeJsonString(utf8Path) << ",\"rect\":{\"x\":" << sample.rect.left
            << ",\"y\":" << sample.rect.top << ",\"width\":"
            << static_cast<std::int64_t>(sample.rect.right) - sample.rect.left << ",\"height\":"
            << static_cast<std::int64_t>(sample.rect.bottom) - sample.rect.top << "}}\n";
  std::cout.flush();
}

bool ParseParentPid(const wchar_t* text, DWORD* parentPid) {
  if (!text || !*text) return false;
  wchar_t* end = nullptr;
  const unsigned long value = std::wcstoul(text, &end, 10);
  if (!end || *end != L'\0' || value == 0 || value > MAXDWORD) return false;
  *parentPid = static_cast<DWORD>(value);
  return true;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  bool watch = false;
  DWORD parentPid = 0;
  if (argc == 2 && std::wstring(argv[1]) == L"--once") {
    watch = false;
  } else if (argc == 4 && std::wstring(argv[1]) == L"--watch"
      && std::wstring(argv[2]) == L"--parent-pid" && ParseParentPid(argv[3], &parentPid)) {
    watch = true;
  } else {
    return 2;
  }

  HANDLE parent = nullptr;
  if (watch) {
    parent = OpenProcess(SYNCHRONIZE, FALSE, parentPid);
    if (!parent) {
      WriteUnavailable();
      return 3;
    }
  }

  // Coordinates are physical screen pixels. Electron must convert them to its
  // display DIP space using the matched display's scale factor before placement.
  const bool dpiAware = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) != FALSE;
  do {
    if (watch && WaitForSingleObject(parent, 0) != WAIT_TIMEOUT) break;
    WriteSample(ReadForegroundWindow(dpiAware));
    if (!std::cout.good()) break;  // A closed consumer pipe must not leave a sampler running.
    if (!watch) break;
    Sleep(kSampleIntervalMs);  // exactly 2 Hz maximum; one foreground HWND per sample
  } while (true);

  if (parent) CloseHandle(parent);
  return 0;
}
