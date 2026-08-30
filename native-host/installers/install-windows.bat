@echo off
REM ╔══════════════════════════════════════════════════════════╗
REM ║  StreamCam — One-Click Installer for Windows             ║
REM ║                                                          ║
REM ║  Double-click this file to install.                      ║
REM ║  It will:                                                ║
REM ║    1. Find the StreamCam extension directory              ║
REM ║    2. Install Node.js dependencies                        ║
REM ║    3. Register the native host with Chrome                ║
REM ║    4. Compile the virtual camera filter                   ║
REM ╚══════════════════════════════════════════════════════════╝

title StreamCam Installer

echo.
echo ╔══════════════════════════════════════════════════╗
echo ║   StreamCam — One-Click Installer               ║
echo ╚══════════════════════════════════════════════════╝
echo.

REM ── Find the native-host directory ──────────────────────────────

set SCRIPT_DIR=%~dp0
set HOST_DIR=%SCRIPT_DIR%..

REM Verify we're in the right place
if not exist "%HOST_DIR%\host.js" (
    echo Error: Could not find host.js
    echo Make sure this installer is in the native-host\installers\ folder
    echo inside the StreamCam extension directory.
    echo.
    pause
    exit /b 1
)

echo Extension directory: %HOST_DIR%\..
echo.

REM ── Check for Node.js ───────────────────────────────────────────

echo Checking for Node.js...
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo Node.js not found. Attempting to install via winget...
    where winget >nol 2>&1
    if %ERRORLEVEL% equ 0 (
        winget install OpenJS.NodeJS.LTS
    ) else (
        echo.
        echo Please install Node.js from https://nodejs.org
        echo Then re-run this installer.
        echo.
        pause
        exit /b 1
    )
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo Node.js found: %NODE_VER%

REM ── Check for FFmpeg ────────────────────────────────────────────

echo.
echo Checking for FFmpeg...
where ffmpeg >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo FFmpeg not found. Attempting to install via winget...
    where winget >nul 2>&1
    if %ERRORLEVEL% equ 0 (
        winget install Gyan.FFmpeg
    ) else (
        echo Please install FFmpeg from https://ffmpeg.org
        echo and add it to your PATH.
    )
) else (
    echo FFmpeg found.
)

REM ── Install npm dependencies ────────────────────────────────────

echo.
echo Installing dependencies...
cd /d "%HOST_DIR%"
call npm install --production
if %ERRORLEVEL% neq 0 (
    echo Failed to install dependencies.
    pause
    exit /b 1
)
echo Dependencies installed.

REM ── Detect extension ID ─────────────────────────────────────────

set EXTENSION_ID=

REM Check cached ID
if exist "%HOST_DIR%\.extension-id" (
    set /p EXTENSION_ID=<"%HOST_DIR%\.extension-id"
    echo Using cached extension ID: %EXTENSION_ID%
)

REM ── Register native host ────────────────────────────────────────

echo.
echo Registering native host with Chrome...

if defined EXTENSION_ID (
    node install.js --id=%EXTENSION_ID%
) else (
    echo.
    echo Could not auto-detect extension ID.
    echo Please enter your extension ID (from chrome://extensions):
    echo.
    set /p EXTENSION_ID="Extension ID (or press Enter to skip): "
    if defined EXTENSION_ID (
        node install.js --id=%EXTENSION_ID%
    ) else (
        echo Skipping host registration. Re-run with --id later.
    )
)

REM ── Compile virtual camera filter ───────────────────────────────

echo.
echo Setting up virtual camera...
node vcam-setup.js setup

REM ── Done ────────────────────────────────────────────────────────

echo.
echo ═══════════════════════════════════════════════════
echo Installation complete!
echo.
echo Next steps:
echo   1. Restart Chrome
echo   2. Click the StreamCam icon
echo   3. Click "Virtual Cam" to test
echo ═══════════════════════════════════════════════════
echo.
pause
