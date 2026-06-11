@echo off
setlocal
REM HiChat native audio capture build script - hardened 2026-05-27
REM
REM Security flags applied:
REM   /GS          Stack buffer overrun detection (canaries)
REM   /sdl         Security Development Lifecycle checks (superset of /GS)
REM   /guard:cf    Control Flow Guard (CFG) - runtime indirect call validation
REM   /DYNAMICBASE Address Space Layout Randomization (ASLR)
REM   /NXCOMPAT    Data Execution Prevention (DEP) marker
REM   /HIGHENTROPYVA  64-bit ASLR (Windows 8+)
REM   /WX          Treat warnings as errors (catches issues at build time)
REM
REM Hardening verification mirrors the CI step "Verify audio-capture.exe
REM hardening flags" in .github/workflows/build-desktop.yml: each flag is
REM asserted individually against dumpbin /headers /loadconfig output, and a
REM missing flag fails the build. Note: CFG appears as "Control Flow Guard"
REM (/headers, newer dumpbin) or "CF Instrumented" (/loadconfig) - never as
REM "CF Guard".

echo Locating MSVC environment...
set "VCVARS64="
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" goto :vswhere_done
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find VC\Auxiliary\Build\vcvars64.bat`) do set "VCVARS64=%%i"
:vswhere_done

if defined VCVARS64 goto :have_vcvars
REM vswhere unavailable or found nothing - probe well-known install paths.
for %%p in (
    "%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools"
    "%ProgramFiles%\Microsoft Visual Studio\2022\Community"
    "%ProgramFiles%\Microsoft Visual Studio\2022\Professional"
    "%ProgramFiles%\Microsoft Visual Studio\2022\Enterprise"
    "%ProgramFiles(x86)%\Microsoft Visual Studio\2019\BuildTools"
    "%ProgramFiles(x86)%\Microsoft Visual Studio\2019\Community"
    "%ProgramFiles(x86)%\Microsoft Visual Studio\2019\Professional"
    "%ProgramFiles(x86)%\Microsoft Visual Studio\2019\Enterprise"
) do if not defined VCVARS64 if exist "%%~p\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS64=%%~p\VC\Auxiliary\Build\vcvars64.bat"

if defined VCVARS64 goto :have_vcvars
where cl.exe >nul 2>&1
if errorlevel 1 (
    echo ERROR: vcvars64.bat not found and cl.exe is not in PATH.
    echo Install Visual Studio 2019/2022 with the C++ build tools workload,
    echo or run this script from a Developer Command Prompt.
    exit /b 1
)
echo vcvars64.bat not found, but cl.exe is already in PATH - using current environment.
goto :compile

:have_vcvars
echo Using %VCVARS64%
call "%VCVARS64%" >nul 2>&1
if errorlevel 1 (
    echo ERROR: vcvars64.bat failed
    exit /b 1
)

:compile
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
set "DUMPFILE=%TEMP%\audio-capture-dumpbin.txt"
dumpbin.exe /headers /loadconfig "%~dp0audio-capture.exe" > "%DUMPFILE%" 2>nul
if errorlevel 1 (
    echo ERROR: dumpbin.exe failed - cannot verify hardening flags
    del "%DUMPFILE%" >nul 2>&1
    exit /b 1
)

REM One findstr per flag: a single findstr with multiple /C: patterns succeeds
REM when ANY pattern matches, so it cannot detect one missing flag. The two
REM /C: patterns on the CFG line are intentionally OR'ed - either marker
REM proves CFG is enabled.
set "MISSING="
findstr /C:"NX compatible" "%DUMPFILE%" >nul || set "MISSING=%MISSING% NX-compatible/DEP"
findstr /C:"Dynamic base" "%DUMPFILE%" >nul || set "MISSING=%MISSING% Dynamic-base/ASLR"
findstr /C:"High Entropy Virtual Addresses" "%DUMPFILE%" >nul || set "MISSING=%MISSING% High-Entropy-VA"
findstr /C:"Control Flow Guard" /C:"CF Instrumented" "%DUMPFILE%" >nul || set "MISSING=%MISSING% Control-Flow-Guard/CFG"
del "%DUMPFILE%" >nul 2>&1

if defined MISSING goto :missing_flags
echo All hardening flags present: DEP, ASLR, High Entropy VA, CFG
exit /b 0

:missing_flags
echo ERROR: audio-capture.exe is missing hardening flags:%MISSING%
exit /b 1
