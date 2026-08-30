# ═══════════════════════════════════════════════════════════════
# StreamCam — Windows Installer Builder
#
# Creates a small .exe installer using iexpress (built into
# every Windows install, no downloads needed).
#
# Usage (in PowerShell):
#   cd native-host\installer
#   .\build-win.ps1
#
# Output: dist\StreamCam-Installer-Setup.exe
# ═══════════════════════════════════════════════════════════════

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$DistDir = Join-Path $ScriptDir "dist"
$Version = "1.0.0"

Write-Host "StreamCam Windows Installer Builder" -ForegroundColor Cyan
Write-Host "====================================" -ForegroundColor Cyan
Write-Host ""

# Clean
if (Test-Path $DistDir) { Remove-Item -Recurse -Force $DistDir }
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

# Staging directory with all host files
$Staging = Join-Path $DistDir "staging"
New-Item -ItemType Directory -Force -Path $Staging | Out-Null

Write-Host "Copying host files..."
Copy-Item "$ProjectRoot\host.js" "$Staging\"
Copy-Item "$ProjectRoot\install.js" "$Staging\"
Copy-Item "$ProjectRoot\vcam-setup.js" "$Staging\"
Copy-Item "$ProjectRoot\package.json" "$Staging\"
Copy-Item -Recurse "$ProjectRoot\platform" "$Staging\"
New-Item -ItemType Directory -Force -Path "$Staging\installers" | Out-Null

# Create install.bat — this runs when the .exe is launched
Write-Host "Creating installer script..."
$BatContent = @"
@echo off
title StreamCam Installer
color 0F

echo.
echo  ========================================
echo   StreamCam Installer
echo  ========================================
echo.

:: Check Node.js
echo  Checking for Node.js...
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo.
    echo  Node.js is NOT installed.
    echo  Please install from: https://nodejs.org
    echo.
    start https://nodejs.org
    echo  Press any key after installing Node.js...
    pause >nul
    where node >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        echo  Node.js still not found. Aborting.
        pause
        exit /b 1
    )
)
echo  Node.js found.
echo.

:: Install npm dependencies
echo  Installing dependencies...
cd /d "%~dp0"
call npm install --production >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  Failed to install dependencies.
    pause
    exit /b 1
)
echo  Dependencies installed.
echo.

:: Register native host
echo  Registering native host with Chrome...
node install.js
echo.

:: Setup virtual camera
echo  Setting up virtual camera...
node vcam-setup.js setup
echo.

echo  ========================================
echo   Installation complete!
echo.
echo   1. Restart Chrome
echo   2. Click the StreamCam icon
echo   3. Click "Virtual Cam" to test
echo  ========================================
echo.
pause
"@

Set-Content -Path "$Staging\install.bat" -Value $BatContent -Encoding ASCII

# Create iexpress SED file
Write-Host "Creating iexpress config..."
$SedContent = @"
[Version]
Class=IEXPRESS
TEDVer=2000
[Options]
PackagePurpose=Install
ShowInstallProgram=1
SelfExtract=1
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FGUICID=%FGUICID%
AppName=StreamCam Installer
AppVersion=$Version
AppPublisher=Alresia
AppPublisherURL=https://github.com/alresiainc/AlresiaStreamCam
AppCopyright=MIT License
OrigName=%OrigName%
StagingDir=$Staging
CompressionType=MSZIP
FileReset=0
SourceDir=$Staging
[ExtractionOptions]
ShowProgress=1
HideFileProgress=1
RunProgram=install.bat
"@

$SedPath = Join-Path $DistDir "installer.sed"
Set-Content -Path $SedPath -Value $SedContent -Encoding ASCII

# Build using iexpress
Write-Host "Building .exe with iexpress..."
$ExePath = Join-Path $DistDir "StreamCam-Installer-Setup.exe"

# iexpress /N runs silently with the SED file
& iexpress /N $SedPath

# iexpress outputs to the current directory by default
$BuiltExe = Join-Path (Get-Location) "StreamCam-Installer.exe"
if (Test-Path $BuiltExe) {
    Move-Item $BuiltExe $ExePath -Force
}

# Cleanup
Remove-Item -Recurse -Force $Staging -ErrorAction SilentlyContinue
Remove-Item $SedPath -ErrorAction SilentlyContinue

if (Test-Path $ExePath) {
    $Size = [math]::Round((Get-Item $ExePath).Length / 1KB)
    Write-Host ""
    Write-Host "Built: dist\StreamCam-Installer-Setup.exe ($Size KB)" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Build may have failed. Check the dist folder." -ForegroundColor Yellow
}
