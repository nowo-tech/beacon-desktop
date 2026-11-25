; NSIS installer hooks of Beacon Desktop, formerly TimeTrack (tauri.conf.json → bundle.windows.nsis.installerHooks).
;
; Visible name (0.9.0, design Q-BD-1 option A): `productName` stays "TimeTrack", so the install folder
; (%LOCALAPPDATA%\TimeTrack), the Uninstall key, HKCU\Software\nowo.tech\TimeTrack and the start-at-login value keep
; their names and the in-app updater keeps upgrading in place. Only what people see is renamed after Tauri's own
; steps: the Start-menu and desktop shortcuts (TT_BRAND_SHORTCUT; same target, same AppUserModelID, so toasts and
; their notification setting carry over) and the name in Settings > Apps (the Uninstall entry's DisplayName).
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
!define TT_DISPLAY_NAME "Beacon Desktop"
!define TT_KEY "Software\nowo.tech\TimeTrack"
!define TT_LEGACY_VENDOR_KEY "Software\nowo"
!define TT_LEGACY_KEY "Software\nowo\TimeTrack"
!define TT_LEGACY_PUBLISHER "nowo"
!define TT_UNINSTALL_ROOT "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
!define TT_RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

Var TTLegacyMsiCode
Var TTLegacyMsiVersion
Var TTLegacyMsiDir
Var TTRunSnapshot
Var TTRunSnapshotTaken

; A page without UI: its function runs before the welcome and reinstall pages (interactive and /P) and never shows.
Page custom TTMigrateLegacy

Function TTMigrateLegacy
  Call TTAdoptLegacyNsis
  Call TTSnapshotAutostart
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

;; $R7 = "1" when the Run command CMD starts with the executable PATH, quoted or not, and the path ends there: end
;; of the command or a space after it, or its closing quote (`…\timetrack.exe.evil.exe` does not match
;; `…\timetrack.exe`). Case-insensitive, like NSIS string comparisons. Uses $R4 / $R5 / $R6 (saved).
!macro TT_STARTS_WITH CMD PATH
  Push $R4
  Push $R5
  Push $R6
  StrLen $R5 "${PATH}"
  ; Unquoted: PATH, then the end or a space.
  StrCpy $R6 "${CMD}" $R5
  ${If} $R6 == "${PATH}"
    StrCpy $R6 "${CMD}" 1 $R5
    ${If} $R6 == ""
    ${OrIf} $R6 == " "
      StrCpy $R7 "1"
    ${EndIf}
  ${EndIf}
  ; Quoted: ", PATH, then the closing ".
  StrCpy $R6 "${CMD}" 1
  ${If} $R6 == '"'
    StrCpy $R6 "${CMD}" $R5 1
    ${If} $R6 == "${PATH}"
      IntOp $R4 $R5 + 1
      StrCpy $R6 "${CMD}" 1 $R4
      ${If} $R6 == '"'
        StrCpy $R7 "1"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $R6
  Pop $R5
  Pop $R4
!macroend

;; OUT = "1" when the Run command CMD starts (anchored, quoted or not) one of the app's executables (TimeTrack.exe or
;; time-track-desktop.exe) in one of its install folders (%LOCALAPPDATA%\TimeTrack, Program Files\TimeTrack, or this
;; install's folder, also a custom one), like is_ours in src-tauri/src/autostart.rs. Another product's entry is never
;; matched. Uses $R7 (saved).
!macro TT_OUR_COMMAND CMD OUT
  Push $R7
  StrCpy $R7 ""
  !insertmacro TT_STARTS_WITH "${CMD}" "$PROGRAMFILES64\${TT_PRODUCT}\time-track-desktop.exe"
  !insertmacro TT_STARTS_WITH "${CMD}" "$PROGRAMFILES64\${TT_PRODUCT}\timetrack.exe"
  !insertmacro TT_STARTS_WITH "${CMD}" "$LOCALAPPDATA\${TT_PRODUCT}\time-track-desktop.exe"
  !insertmacro TT_STARTS_WITH "${CMD}" "$LOCALAPPDATA\${TT_PRODUCT}\timetrack.exe"
  !insertmacro TT_STARTS_WITH "${CMD}" "$INSTDIR\time-track-desktop.exe"
  !insertmacro TT_STARTS_WITH "${CMD}" "$INSTDIR\timetrack.exe"
  StrCpy ${OUT} $R7
  Pop $R7
!macroend

;; Renames this install's "TimeTrack.lnk" in DIR to "Beacon Desktop.lnk". Only a shortcut that starts this install's
;; executable is touched; an older "Beacon Desktop.lnk" of this install is replaced, another product's never. Tauri
;; creates "TimeTrack.lnk" on a fresh install and skips it on an update, so after the first 0.9.0+ install there is
;; one shortcut, with the new name. A desktop shortcut ticked on the finish page is created after this hook: it keeps
;; the old name until the next update. Uses $0-$3 (Tauri's IsShortcutTarget).
!macro TT_BRAND_SHORTCUT DIR
  ${If} ${FileExists} "${DIR}\${TT_PRODUCT}.lnk"
    !insertmacro IsShortcutTarget "${DIR}\${TT_PRODUCT}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      ${If} ${FileExists} "${DIR}\${TT_DISPLAY_NAME}.lnk"
        !insertmacro IsShortcutTarget "${DIR}\${TT_DISPLAY_NAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        Pop $0
        ${If} $0 = 1
          Delete "${DIR}\${TT_DISPLAY_NAME}.lnk"
        ${EndIf}
      ${EndIf}
      ClearErrors
      Rename "${DIR}\${TT_PRODUCT}.lnk" "${DIR}\${TT_DISPLAY_NAME}.lnk"
      ${If} ${Errors}
        DetailPrint "Kept the shortcut ${DIR}\${TT_PRODUCT}.lnk"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

;; Removes this install's "Beacon Desktop.lnk" from DIR (Tauri's uninstaller only knows "TimeTrack.lnk").
!macro TT_REMOVE_BRANDED_SHORTCUT DIR
  ${If} ${FileExists} "${DIR}\${TT_DISPLAY_NAME}.lnk"
    !insertmacro IsShortcutTarget "${DIR}\${TT_DISPLAY_NAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "${DIR}\${TT_DISPLAY_NAME}.lnk"
      Delete "${DIR}\${TT_DISPLAY_NAME}.lnk"
    ${EndIf}
  ${EndIf}
!macroend

; Start at login before the old copy is uninstalled. Interactive and /P (without /UPDATE) upgrades run the old
; uninstaller from the reinstall page ("Uninstall before installing") without /UPDATE, and Tauri's uninstall step then
; deletes HKCU\...\Run\TimeTrack (it keeps the value only for updates). The old uninstaller is the old version's
; code, so the new installer remembers the value here, before that page, and NSIS_HOOK_POSTINSTALL writes it back for
; this install. Only a value that starts one of the app's executables in one of its install folders counts ($INSTDIR
; is the previous install's folder here); its Task Manager state (StartupApproved) is not touched by the uninstaller
; and carries over. Once per run: going back to the pages after the old copy is gone must not forget it.
Function TTSnapshotAutostart
  ${If} $TTRunSnapshotTaken == "1"
    Return
  ${EndIf}
  StrCpy $TTRunSnapshotTaken "1"
  StrCpy $TTRunSnapshot ""
  ReadRegStr $0 HKCU "${TT_RUN_KEY}" "${TT_PRODUCT}"
  ${If} $0 != ""
    !insertmacro TT_OUR_COMMAND $0 $1
    ${If} $1 != ""
      StrCpy $TTRunSnapshot $0
    ${EndIf}
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  ; Visible name: Settings > Apps lists "Beacon Desktop"; the key stays Uninstall\TimeTrack (Tauri finds the install
  ; there on the next update).
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${TT_DISPLAY_NAME}"
  !insertmacro TT_BRAND_SHORTCUT "$SMPROGRAMS"
  !insertmacro TT_BRAND_SHORTCUT "$DESKTOP"
  ; The 0.1.0 NSIS key is stale once this version is installed (its Uninstall entry was rewritten above). A 0.1.0 MSI
  ; that is still installed uses the same key for its shortcut: keep it then, or Windows would "repair" that copy.
  Call TTFindLegacyMsi
  ${If} $TTLegacyMsiCode == ""
    DeleteRegKey HKCU "${TT_LEGACY_KEY}"
    DeleteRegKey /ifempty HKCU "${TT_LEGACY_VENDOR_KEY}"
  ${EndIf}
  ; Start at login removed by the old uninstaller (TTSnapshotAutostart): written back for this install, quoted, hidden in
  ; the tray. Only when the value is gone: a value still there (silent install, /UPDATE, nothing was uninstalled) is
  ; handled below. Start at login that was off stays off (no snapshot).
  ${If} $TTRunSnapshot != ""
    ReadRegStr $R8 HKCU "${TT_RUN_KEY}" "${TT_PRODUCT}"
    ${If} $R8 == ""
      WriteRegStr HKCU "${TT_RUN_KEY}" "${TT_PRODUCT}" '"$INSTDIR\${MAINBINARYNAME}.exe" --hidden'
      DetailPrint "Kept start at login of ${TT_PRODUCT} (removed by the old uninstaller)"
    ${EndIf}
  ${EndIf}
  ; Start at login set up by the 0.1.0 MSI copy points at Program Files: follow the app to this install, also when that
  ; copy is kept (0.5.0 left it then, and both copies could start at login: two tray icons). Only this install starts
  ; at login; the old copy can still be opened by hand. Only a value that starts one of the app's executables is
  ; changed (another product may use the name "TimeTrack"); its Task Manager state (StartupApproved) is kept. The path
  ; is written quoted, for custom install folders too.
  ReadRegStr $R8 HKCU "${TT_RUN_KEY}" "${TT_PRODUCT}"
  !insertmacro TT_OUR_COMMAND $R8 $R9
  ${If} $R9 != ""
    ; This install's executable, path quoted (no unquoted-path search at login), hidden in the tray.
    StrCpy $R9 '"$INSTDIR\${MAINBINARYNAME}.exe" --hidden'
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

!macro NSIS_HOOK_PREUNINSTALL
  ; An update (/UPDATE) keeps the shortcuts, like Tauri's own uninstall step.
  ${If} $UpdateMode <> 1
    !insertmacro TT_REMOVE_BRANDED_SHORTCUT "$SMPROGRAMS"
    !insertmacro TT_REMOVE_BRANDED_SHORTCUT "$DESKTOP"
  ${EndIf}
!macroend
