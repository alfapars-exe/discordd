@echo off
setlocal
REM Build the standalone foreground-window query helper with hardened MSVC flags.

where cl.exe >nul 2>&1
if errorlevel 1 (
    echo ERROR: cl.exe not found. Run from an MSVC Developer Command Prompt.
    exit /b 1
)

echo Compiling game-window.cpp with hardening flags...
cl.exe ^
    /nologo /std:c++17 /EHsc /O2 /W3 /WX ^
    /GS /sdl /guard:cf /DUNICODE /D_UNICODE ^
    "%~dp0game-window.cpp" ^
    /Fe:"%~dp0game-window.exe" ^
    user32.lib /link /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA /GUARD:CF
if errorlevel 1 (
    echo ERROR: Compilation failed.
    exit /b 1
)

echo Verifying DEP, ASLR, High Entropy VA, and CFG...
set "DUMPFILE=%TEMP%\hichat-game-window-%RANDOM%-%RANDOM%.txt"
dumpbin.exe /headers /loadconfig "%~dp0game-window.exe" > "%DUMPFILE%" 2>nul
if errorlevel 1 (
    echo ERROR: dumpbin.exe failed - cannot verify hardening flags.
    del "%DUMPFILE%" >nul 2>&1
    exit /b 1
)
set "MISSING="
findstr /C:"NX compatible" "%DUMPFILE%" >nul || set "MISSING=%MISSING% DEP"
findstr /C:"Dynamic base" "%DUMPFILE%" >nul || set "MISSING=%MISSING% ASLR"
findstr /C:"High Entropy Virtual Addresses" "%DUMPFILE%" >nul || set "MISSING=%MISSING% High-Entropy-VA"
findstr /C:"Control Flow Guard" /C:"CF Instrumented" "%DUMPFILE%" >nul || set "MISSING=%MISSING% CFG"
del "%DUMPFILE%" >nul 2>&1
if defined MISSING (
    echo ERROR: Missing hardening flags:%MISSING%
    exit /b 1
)
echo Build successful: native\game-window.exe
exit /b 0
