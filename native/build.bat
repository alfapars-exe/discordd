@echo off
REM HiChat native audio capture build script — hardened 2026-05-27
REM
REM Security flags applied:
REM   /GS          Stack buffer overrun detection (canaries)
REM   /sdl         Security Development Lifecycle checks (superset of /GS)
REM   /guard:cf    Control Flow Guard (CFG) — runtime indirect call validation
REM   /DYNAMICBASE Address Space Layout Randomization (ASLR)
REM   /NXCOMPAT    Data Execution Prevention (DEP) marker
REM   /HIGHENTROPYVA  64-bit ASLR (Windows 8+)
REM   /WX          Treat warnings as errors (catches issues at build time)
REM
REM To verify after build:
REM   dumpbin.exe /headers audio-capture.exe | findstr /C:"NX" /C:"Dynamic" /C:"CF Guard" /C:"High Entropy"

echo Setting up MSVC environment...
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
if errorlevel 1 (
    echo ERROR: vcvars64.bat failed
    exit /b 1
)
echo Compiling audio-capture.cpp with hardening flags...
cl.exe ^
    /EHsc /O2 /W3 /WX ^
    /GS /sdl /guard:cf ^
    "%~dp0audio-capture.cpp" ^
    /Fe:"%~dp0audio-capture.exe" ^
    ole32.lib mmdevapi.lib ^
    /link /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA /GUARD:CF
if errorlevel 1 (
    echo ERROR: Compilation failed
    exit /b 1
)
echo Build successful: native\audio-capture.exe
echo Verifying hardening flags...
dumpbin.exe /headers "%~dp0audio-capture.exe" 2>nul | findstr /C:"NX" /C:"Dynamic" /C:"CF Guard" /C:"High Entropy"
if errorlevel 1 (
    echo WARNING: dumpbin.exe not in PATH or hardening flags missing
    echo Manually verify with: dumpbin.exe /headers audio-capture.exe
)
