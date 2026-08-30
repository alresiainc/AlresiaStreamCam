@echo off
REM StreamCam Virtual Camera — Windows Build Script
REM
REM Compiles the DirectShow source filter that creates a virtual camera on Windows.
REM Run this once (or the native host runs it automatically on first use).
REM
REM Requirements: Visual Studio Build Tools (or full VS) with C compiler
REM   winget install Microsoft.VisualStudio.2022.BuildTools

echo StreamCam Virtual Camera — Windows Build
echo =========================================
echo.

set SCRIPT_DIR=%~dp0
set SOURCE=%SCRIPT_DIR%streamcam-vcam.c
set OUTPUT_DIR=%SCRIPT_DIR%build

REM Check for compiler
where cl >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo Error: cl.exe not found.
    echo Install Visual Studio Build Tools:
    echo   winget install Microsoft.VisualStudio.2022.BuildTools
    echo Or open "Developer Command Prompt for VS"
    exit /b 1
)

echo Source: %SOURCE%
echo Output: %OUTPUT_DIR%\StreamCamVirtualCam.dll
echo.

if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"

REM Compile
echo Compiling...
cl /LD /O2 /W3 ^
    "%SOURCE%" ^
    /link /DEF:%SCRIPT_DIR%streamcam-vcam.def ^
    strmiids.lib ole32.lib oleaut32.lib uuid.lib ^
    /OUT:"%OUTPUT_DIR%\StreamCamVirtualCam.dll" ^
    /IMPLIB:"%OUTPUT_DIR%\StreamCamVirtualCam.lib"

if %ERRORLEVEL% neq 0 (
    echo.
    echo Build failed. Make sure you're using the VS Developer Command Prompt.
    exit /b 1
)

echo.
echo Build successful!
echo DLL: %OUTPUT_DIR%\StreamCamVirtualCam.dll
echo.
echo To register the virtual camera (run as Administrator):
echo   regsvr32 "%OUTPUT_DIR%\StreamCamVirtualCam.dll"
echo.
echo To unregister:
echo   regsvr32 /u "%OUTPUT_DIR%\StreamCamVirtualCam.dll"
