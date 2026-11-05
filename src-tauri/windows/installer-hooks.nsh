; TimeTrack NSIS installer hooks (tauri.conf.json → bundle.windows.nsis.installerHooks).
;
; Upgrades from 0.1.0. That release was built without `bundle.publisher`, so Tauri used the identifier's second part
; ("nowo") as the Windows manufacturer; since 0.4.0 it is "nowo.tech". Tauri keys two things on the manufacturer:
;   - HKCU\Software\<manufacturer>\TimeTrack holds the install directory. The reinstall page ("Uninstall before
;     installing") runs the old uninstaller with `_?=<that directory>`; the 0.4.0 installer read the new key, found
;     nothing and ran `uninstall.exe _?=`, which fails: "Unable to uninstall!".
;   - Its WiX lookup only matches an MSI whose Publisher is the current manufacturer, so the 0.1.0 MSI (per machine,
;     Program Files) was never noticed and stayed installed next to the per-user NSIS install.
; TTMigrateLegacy runs first, before Tauri's own pages: it points the new key at a 0.1.0 NSIS install (so the
; reinstall page works and the upgrade lands in the same folder) and offers to remove a 0.1.0 MSI.
;
; This file is included near the top of Tauri's installer.nsi, before its defines (PRODUCTNAME, MANUFACTURER,
; MAINBINARYNAME) and variables, so the functions spell names out. Pages do not run with /S: a silent install
; overwrites a 0.1.0 NSIS install in place (same folder, same Uninstall entry) and leaves a 0.1.0 MSI alone.

!define TT_PRODUCT "TimeTrack"
!define TT_KEY "Software\nowo.tech\TimeTrack"
!define TT_LEGACY_VENDOR_KEY "Software\nowo"
!define TT_LEGACY_KEY "Software\nowo\TimeTrack"
!define TT_LEGACY_PUBLISHER "nowo"
!define TT_UNINSTALL_ROOT "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
!define TT_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

Var TTLegacyMsiCode
Var TTLegacyMsiVersion
Var TTLegacyMsiDir

; A page without UI: its function runs before the welcome and reinstall pages (interactive and /P) and never shows.
Page custom TTMigrateLegacy

Function TTMigrateLegacy
  Call TTAdoptLegacyNsis
  Call TTFindLegacyMsi
  ${If} $TTLegacyMsiCode != ""
    Call TTRemoveLegacyMsi
  ${EndIf}
FunctionEnd

; A 0.1.0 per-user NSIS install: copy its directory to the current key, unless an install already wrote that key.
Function TTAdoptLegacyNsis
  ReadRegStr $0 HKCU "${TT_KEY}" ""
  ${If} $0 == ""
    ReadRegStr $0 HKCU "${TT_LEGACY_KEY}" ""
    ${If} $0 != ""
    ${AndIf} ${FileExists} "$0\uninstall.exe"
      WriteRegStr HKCU "${TT_KEY}" "" "$0"
      StrCpy $INSTDIR "$0"
    ${EndIf}
  ${EndIf}
FunctionEnd

; A 0.1.0 MSI: Uninstall\{ProductCode} in HKLM (64-bit view, set by Tauri's .onInit) with DisplayName "TimeTrack",
; Publisher "nowo" and an msiexec uninstall string.
Function TTFindLegacyMsi
  StrCpy $TTLegacyMsiCode ""
  StrCpy $0 0
  tt_msi_loop:
    EnumRegKey $1 HKLM "${TT_UNINSTALL_ROOT}" $0
    StrCmp $1 "" tt_msi_done
    IntOp $0 $0 + 1
    StrCpy $2 $1 1
    StrCmp $2 "{" 0 tt_msi_loop
    ReadRegStr $2 HKLM "${TT_UNINSTALL_ROOT}\$1" "DisplayName"
    StrCmp $2 "${TT_PRODUCT}" 0 tt_msi_loop
    ReadRegStr $2 HKLM "${TT_UNINSTALL_ROOT}\$1" "Publisher"
    StrCmp $2 "${TT_LEGACY_PUBLISHER}" 0 tt_msi_loop
    ReadRegStr $2 HKLM "${TT_UNINSTALL_ROOT}\$1" "UninstallString"
    ${StrCase} $3 $2 "L"
    ${StrLoc} $2 $3 "msiexec" ">"
    StrCmp $2 "" tt_msi_loop
    StrCpy $TTLegacyMsiCode $1
    ReadRegStr $TTLegacyMsiVersion HKLM "${TT_UNINSTALL_ROOT}\$1" "DisplayVersion"
    ReadRegStr $TTLegacyMsiDir HKLM "${TT_UNINSTALL_ROOT}\$1" "InstallLocation"
    ${If} $TTLegacyMsiDir == ""
      StrCpy $TTLegacyMsiDir "$PROGRAMFILES64\${TT_PRODUCT}"
    ${EndIf}
  tt_msi_done:
FunctionEnd

; Asks (interactive) and removes the MSI with msiexec's basic UI: Windows asks for administrator approval itself. On
; failure the install goes on, with a message that says how to remove the old copy by hand.
Function TTRemoveLegacyMsi
  ClearErrors
  ${GetOptions} $CMDLINE "/P" $0
  ${If} ${Errors}
    MessageBox MB_YESNO|MB_ICONQUESTION "An older ${TT_PRODUCT} $TTLegacyMsiVersion is installed for all users (the .msi installer).$\r$\n$\r$\nThis version installs for your account only and replaces it. Remove the old version now? Windows asks for administrator approval.$\r$\n$\r$\nChoose No to keep it for now: remove it later in Settings > Apps > Installed apps (${TT_PRODUCT}, publisher $\"${TT_LEGACY_PUBLISHER}$\")." /SD IDYES IDYES tt_remove
    DetailPrint "Kept the old ${TT_PRODUCT} $TTLegacyMsiVersion (MSI)"
    Return
  ${EndIf}
  tt_remove:
  ; Close the old copy (tray included) so msiexec does not stop on files in use. The new app is closed by Tauri's
  ; own running-app check before files are replaced.
  ReadEnvStr $2 USERNAME
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /FI "IMAGENAME eq ${TT_PRODUCT}.exe" /FI "USERNAME eq $2"'
  Pop $1
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /FI "IMAGENAME eq time-track-desktop.exe" /FI "USERNAME eq $2"'
  Pop $1
  ClearErrors
  ExecWait '"$SYSDIR\msiexec.exe" /x $TTLegacyMsiCode /passive /norestart' $1
  ${If} ${Errors}
    StrCpy $1 "not started"
  ${EndIf}
  ReadRegStr $2 HKLM "${TT_UNINSTALL_ROOT}\$TTLegacyMsiCode" "DisplayName"
  ${If} $2 == ""
    DetailPrint "Removed the old ${TT_PRODUCT} $TTLegacyMsiVersion (MSI, exit code $1)"
    StrCpy $TTLegacyMsiCode ""
    Return
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/P" $0
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "The older ${TT_PRODUCT} $TTLegacyMsiVersion (installed for all users) could not be removed (msiexec exit code $1).$\r$\n$\r$\nThis installation continues. Remove the old version yourself: Settings > Apps > Installed apps > ${TT_PRODUCT} (publisher $\"${TT_LEGACY_PUBLISHER}$\") > Uninstall, with an administrator account." /SD IDOK
  ${EndIf}
FunctionEnd

;; OUT = non-empty when the Run command CMD starts one of the app's executables (TimeTrack.exe or
;; time-track-desktop.exe) in one of its install folders (%LOCALAPPDATA%\TimeTrack, Program Files\TimeTrack), like
;; is_ours in src-tauri/src/autostart.rs. Another product's entry is never matched. Uses $R6 and $R7 (saved).
!macro TT_OUR_COMMAND CMD OUT
  Push $R6
  Push $R7
  ${StrCase} ${OUT} "${CMD}" "L"
  StrCpy $R7 ""
  ${StrCase} $R6 "$PROGRAMFILES64\${TT_PRODUCT}\time-track-desktop.exe" "L"
  ${StrLoc} $R7 ${OUT} $R6 ">"
  ${If} $R7 == ""
    ${StrCase} $R6 "$PROGRAMFILES64\${TT_PRODUCT}\timetrack.exe" "L"
    ${StrLoc} $R7 ${OUT} $R6 ">"
  ${EndIf}
  ${If} $R7 == ""
    ${StrCase} $R6 "$LOCALAPPDATA\${TT_PRODUCT}\time-track-desktop.exe" "L"
    ${StrLoc} $R7 ${OUT} $R6 ">"
  ${EndIf}
  ${If} $R7 == ""
    ${StrCase} $R6 "$LOCALAPPDATA\${TT_PRODUCT}\timetrack.exe" "L"
    ${StrLoc} $R7 ${OUT} $R6 ">"
  ${EndIf}
  StrCpy ${OUT} $R7
  Pop $R7
  Pop $R6
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; The 0.1.0 NSIS key is stale once this version is installed (its Uninstall entry was rewritten above). A 0.1.0 MSI
  ; that is still installed uses the same key for its shortcut: keep it then, or Windows would "repair" that copy.
  Call TTFindLegacyMsi
  ${If} $TTLegacyMsiCode == ""
    DeleteRegKey HKCU "${TT_LEGACY_KEY}"
    DeleteRegKey /ifempty HKCU "${TT_LEGACY_VENDOR_KEY}"
  ${EndIf}
  ; Start at login set up by the 0.1.0 MSI copy points at Program Files: follow the app to this install, also when that
  ; copy is kept (0.5.0 left it then, and both copies could start at login: two tray icons). Only this install starts
  ; at login; the old copy can still be opened by hand. Only a value that starts one of the app's executables is
  ; changed (another product may use the name "TimeTrack"); its Task Manager state (StartupApproved) is kept. The app
  ; quotes the path on its next start (src-tauri/src/autostart.rs).
  ReadRegStr $R8 HKCU "${TT_RUN_KEY}" "${TT_PRODUCT}"
  !insertmacro TT_OUR_COMMAND $R8 $R9
  ${If} $R9 != ""
    nsis_tauri_utils::StrReplace "$R8" "$PROGRAMFILES64\${TT_PRODUCT}\" "$INSTDIR\"
    Pop $R9
    ${If} $R9 != $R8
      WriteRegStr HKCU "${TT_RUN_KEY}" "${TT_PRODUCT}" "$R9"
    ${EndIf}
  ${EndIf}
  ; A per-machine "TimeTrack" Run value (HKLM, written by an elevated copy) that starts one of the app's executables in
  ; one of its install folders starts a second copy at login. Removing it needs administrator rights, so this only works from
  ; an elevated installer; otherwise README → "Two TimeTrack icons in the tray" says how to remove it.
  ReadRegStr $R8 HKLM "${TT_RUN_KEY}" "${TT_PRODUCT}"
  !insertmacro TT_OUR_COMMAND $R8 $R9
  ${If} $R9 != ""
    ClearErrors
    DeleteRegValue HKLM "${TT_RUN_KEY}" "${TT_PRODUCT}"
    ${IfNot} ${Errors}
      DetailPrint "Removed the per-machine start-at-login entry of ${TT_PRODUCT}"
    ${EndIf}
  ${EndIf}
  ; Other start-at-login values for this install or the 0.1.0 MSI copy ("time-track-desktop") are removed by the app
  ; itself on its next start (autostart.rs).
!macroend
