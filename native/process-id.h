#pragma once
#include <windows.h>

inline bool ParseProcessId(const wchar_t* text, DWORD* processId) {
  if (!text || !*text) return false;
  DWORD value = 0;
  for (const wchar_t* digit = text; *digit; ++digit) {
    if (*digit < L'0' || *digit > L'9') return false;
    const DWORD part = static_cast<DWORD>(*digit - L'0');
    if (value > (MAXDWORD - part) / 10) return false;
    value = value * 10 + part;
  }
  if (value == 0) return false;
  *processId = value;
  return true;
}
