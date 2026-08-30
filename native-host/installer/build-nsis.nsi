; ═══════════════════════════════════════════════════════════════
; StreamCam — Windows NSIS Installer
;
; Creates a small (~1MB) .exe installer that:
;   1. Checks for Node.js
;   2. Installs dependencies
;   3. Registers native host with Chrome
;   4. Sets up virtual camera
;
; Build (requires NSIS: https://nsis.sourceforge.io):
;   makensis build-nsis.nsi
; ═══════════════════════════════════════════════════════════════

!include "MUI2.nsh"

Name "StreamCam Installer"
OutFile "StreamCam-Installer-Setup.exe"
InstallDir "$LOCALAPPDATA\StreamCam"
RequestExecutionLevel admin

; ── Pages ────────────────────────────────────────────────────

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ── Installer ────────────────────────────────────────────────

Section "Install"
    SetOutPath $INSTDIR

    ; Copy native host files
    File /r "..\host.js"
    File /r "..\install.js"
    File /r "..\vcam-setup.js"
    File /r "..\package.json"
    File /r /x "node_modules" /x "build" "..\platform"
    File /r /x "node_modules" "..\installers"

    ; Create uninstaller
    WriteUninstaller "$INSTDIR\uninstall.exe"

    ; Register with Add/Remove Programs
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\StreamCam" \
        "DisplayName" "StreamCam"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\StreamCam" \
        "UninstallString" '"$INSTDIR\uninstall.exe"'
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\StreamCam" \
        "InstallLocation" "$INSTDIR"

    ; ── Run post-install ──────────────────────────────────────
    DetailPrint "Checking for Node.js..."
    nsExec::ExecToLog 'cmd /c "where node"'
    Pop $0
    ${If} $0 != 0
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
            "Node.js is required but not found.$\n$\nClick OK to open the Node.js download page." \
            IDOK openNode IDCANCEL abortInstall
        openNode:
            ExecShell "open" "https://nodejs.org"
            abortInstall:
                Abort "Please install Node.js first."
    ${EndIf}

    DetailPrint "Installing dependencies..."
    nsExec::ExecToLog 'cmd /c "cd /d $INSTDIR && npm install --production"'

    DetailPrint "Registering native host..."
    ; Extension ID will be prompted or detected
    nsExec::ExecToLog 'cmd /c "cd /d $INSTDIR && node install.js"'

    DetailPrint "Setting up virtual camera..."
    nsExec::ExecToLog 'cmd /c "cd /d $INSTDIR && node vcam-setup.js setup"'
SectionEnd

; ── Uninstaller ──────────────────────────────────────────────

Section "Uninstall"
    RMDir /r "$INSTDIR"
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\StreamCam"
SectionEnd
