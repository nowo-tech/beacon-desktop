<#
.SYNOPSIS
  Installs an older TimeTrack build, upgrades it with a newer NSIS installer and checks the result on real Windows.

.DESCRIPTION
  Used by .github/workflows/installer-upgrade-test.yml (GitHub-hosted windows runners, manual runs only). One scenario
  per run, on a clean machine:

    -Old       msi | nsis | both | none   which of the old installers in -OldDir to install first (MSI per machine with
                                           msiexec /qn, NSIS per user with /S)
    -Mode      silent       new-setup.exe /S
               update       new-setup.exe /P /UPDATE, the arguments the Tauri updater (installMode "passive") passes
               interactive  new-setup.exe with its UI, driven through UI Automation like a user who accepts every
                            default (Next, Install, OK, Yes, Finish); every dialog's text is logged
    -AppRunning              start the old app (it stays in the tray) before the upgrade and leave it running
    -OldMsiStays             the old MSI is expected to stay (/S cannot ask for administrator approval): report it,
                             check the rest
    -Autostart  dupes        (0.5.1+) start-at-login entries seeded before the upgrade: the app's value for the old
                             copy, a second value "time-track-desktop" and a per-machine value
                disabled     the app's value plus a "time-track-desktop" value disabled in Task Manager: the one
                             entry left must be disabled too
                foreign      the app's value plus another vendor's "TimeTrack" entries (HKCU "TimeTrack Vendor",
                             HKLM "TimeTrack" for C:\Vendor\TimeTrack): those must stay untouched

  Then checks: installer exit code, a single "TimeTrack" entry under the Uninstall keys (HKCU and HKLM, both views)
  carrying the new version, no MSI left behind, the installed executable's version and that the app starts. From
  0.5.1 on also: start-at-login entries seeded before the upgrade like older versions left them (the app's value
  pointing at the old copy, a second value under another name, a per-machine value) end up as ONE HKCU "TimeTrack"
  value for the new executable once the new app has started, and a second launch exits at once, leaving one process
  (one tray icon). Writes
  result.json and a Markdown summary to -OutDir (and to $env:GITHUB_STEP_SUMMARY when set). Exit code 1 when a check
  failed. Needs Windows PowerShell 5.1 (UI Automation assemblies).
#>
param(
  [Parameter(Mandatory)] [ValidateSet('msi', 'nsis', 'both', 'none')] [string] $Old,
  [Parameter(Mandatory)] [string] $OldDir,
  [Parameter(Mandatory)] [string] $NewDir,
  [Parameter(Mandatory)] [ValidateSet('silent', 'update', 'interactive')] [string] $Mode,
  [switch] $AppRunning,
  [switch] $OldMsiStays,
  [ValidateSet('dupes', 'disabled', 'foreign')] [string] $Autostart = 'dupes',
  [string] $OutDir = (Join-Path $PWD 'upgrade-test-out'),
  [string] $Product = 'TimeTrack',
  [int] $TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$script:LogFile = Join-Path $OutDir 'upgrade-test.log'
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Dialogs = New-Object System.Collections.Generic.List[string]

function Log([string] $Message) {
  $line = '[{0:HH:mm:ss}] {1}' -f (Get-Date), $Message
  Write-Host $line
  Add-Content -Path $script:LogFile -Value $line
}
function Fail([string] $Message) { $script:Failures.Add($Message); Log "FAIL: $Message" }

# --- Registry -----------------------------------------------------------------------------------------------------

function Get-UninstallEntries {
  $found = @()
  $sources = @(
    @{ Hive = [Microsoft.Win32.RegistryHive]::CurrentUser; View = [Microsoft.Win32.RegistryView]::Registry64; Name = 'HKCU' },
    @{ Hive = [Microsoft.Win32.RegistryHive]::LocalMachine; View = [Microsoft.Win32.RegistryView]::Registry64; Name = 'HKLM64' },
    @{ Hive = [Microsoft.Win32.RegistryHive]::LocalMachine; View = [Microsoft.Win32.RegistryView]::Registry32; Name = 'HKLM32' }
  )
  foreach ($s in $sources) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($s.Hive, $s.View)
    $root = $base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
    if ($null -eq $root) { continue }
    foreach ($name in $root.GetSubKeyNames()) {
      $k = $root.OpenSubKey($name)
      $display = [string] $k.GetValue('DisplayName')
      if ($display -like "$Product*") {
        $found += [pscustomobject] @{
          Hive            = $s.Name
          Key             = $name
          DisplayName     = $display
          DisplayVersion  = [string] $k.GetValue('DisplayVersion')
          Publisher       = [string] $k.GetValue('Publisher')
          InstallLocation = [string] $k.GetValue('InstallLocation')
          UninstallString = [string] $k.GetValue('UninstallString')
        }
      }
      $k.Close()
    }
    $root.Close()
  }
  return , $found
}

function Show-State([string] $Label) {
  Log "--- state: $Label"
  $entries = Get-UninstallEntries
  if ($entries.Count -eq 0) { Log '  (no Uninstall entry)' }
  foreach ($e in $entries) {
    Log ("  {0}\{1}: '{2}' {3} publisher='{4}' location={5} uninstall={6}" -f $e.Hive, $e.Key, $e.DisplayName, $e.DisplayVersion, $e.Publisher, $e.InstallLocation, $e.UninstallString)
  }
  foreach ($vendor in 'nowo', 'nowo.tech') {
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\$vendor\$Product")
    if ($null -ne $k) { Log ("  HKCU\Software\{0}\{1} (default)='{2}'" -f $vendor, $Product, $k.GetValue('')); $k.Close() }
  }
  foreach ($dir in (Get-InstallDirs)) {
    if (Test-Path $dir) {
      $files = (Get-ChildItem -Path $dir -File | ForEach-Object { $_.Name }) -join ', '
      Log "  $dir : $files"
    }
  }
  foreach ($p in (Get-AppProcesses)) { Log ("  running: pid {0} {1}" -f $p.Id, $p.Path) }
  return , $entries
}

function Get-InstallDirs { @((Join-Path $env:LOCALAPPDATA $Product), (Join-Path $env:ProgramFiles $Product)) }

function Get-AppExe([string] $Dir) {
  if (-not (Test-Path $Dir)) { return $null }
  $exe = Get-ChildItem -Path $Dir -Filter '*.exe' -File | Where-Object { $_.Name -notmatch '^(uninstall|unins)' } | Select-Object -First 1
  if ($null -eq $exe) { return $null }
  return $exe.FullName
}

function Get-AppProcesses {
  $dirs = Get-InstallDirs
  @(Get-Process | Where-Object {
      $path = $null
      try { $path = $_.Path } catch { }
      $path -and ($dirs | Where-Object { $path.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) })
    })
}

$RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run'

# Start-at-login values (HKCU and HKLM, 64-bit view) that start some copy of TimeTrack.
function Get-RunEntries {
  $found = @()
  foreach ($s in @(@{ Hive = [Microsoft.Win32.RegistryHive]::CurrentUser; Name = 'HKCU' }, @{ Hive = [Microsoft.Win32.RegistryHive]::LocalMachine; Name = 'HKLM' })) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($s.Hive, [Microsoft.Win32.RegistryView]::Registry64)
    $key = $base.OpenSubKey($RunKey)
    if ($null -eq $key) { continue }
    foreach ($name in $key.GetValueNames()) {
      $command = [string] $key.GetValue($name)
      if ($command -match '(?i)\\(timetrack|time-track-desktop)\.exe') {
        $found += [pscustomobject] @{ Hive = $s.Name; Name = $name; Command = $command }
      }
    }
    $key.Close()
  }
  return , $found
}

function Set-RunEntry([string] $Hive, [string] $Name, [string] $Command) {
  $root = if ($Hive -eq 'HKLM') { [Microsoft.Win32.RegistryHive]::LocalMachine } else { [Microsoft.Win32.RegistryHive]::CurrentUser }
  $key = [Microsoft.Win32.RegistryKey]::OpenBaseKey($root, [Microsoft.Win32.RegistryView]::Registry64).CreateSubKey($RunKey)
  $key.SetValue($Name, $Command)
  $key.Close()
  Log "seeded start-at-login $Hive\$Name = $Command"
}

$ApprovedKey = 'Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
# Task Manager "Disabled" (first byte 3, then the time it was disabled); "Enabled" is 2 followed by zeros.
$DisabledMarker = [byte[]] (3, 0, 0, 0, 0x10, 0x8e, 0x3c, 0x51, 0x2a, 0x4e, 0xdb, 0x01)
$Vendor = 'C:\Vendor\TimeTrack'

function Open-Hive([string] $Hive) {
  $root = if ($Hive -eq 'HKLM') { [Microsoft.Win32.RegistryHive]::LocalMachine } else { [Microsoft.Win32.RegistryHive]::CurrentUser }
  [Microsoft.Win32.RegistryKey]::OpenBaseKey($root, [Microsoft.Win32.RegistryView]::Registry64)
}

function Get-RunValue([string] $Hive, [string] $Name) {
  $key = (Open-Hive $Hive).OpenSubKey($RunKey)
  if ($null -eq $key) { return $null }
  $value = $key.GetValue($Name); $key.Close(); return $value
}

function Set-Approved([string] $Hive, [string] $Name, [byte[]] $Bytes) {
  $key = (Open-Hive $Hive).CreateSubKey($ApprovedKey)
  $key.SetValue($Name, $Bytes, [Microsoft.Win32.RegistryValueKind]::Binary)
  $key.Close()
  Log "seeded Task Manager state $Hive\$Name = $([BitConverter]::ToString($Bytes))"
}

function Get-Approved([string] $Hive, [string] $Name) {
  $key = (Open-Hive $Hive).OpenSubKey($ApprovedKey)
  if ($null -eq $key) { return $null }
  $value = $key.GetValue($Name); $key.Close()
  if ($null -eq $value) { return $null }
  return , $value
}

function Test-Disabled($Bytes) { $null -ne $Bytes -and $Bytes.Length -ge 8 -and @($Bytes[($Bytes.Length - 8)..($Bytes.Length - 1)] | Where-Object { $_ -ne 0 }).Count -gt 0 }

# --- Processes ----------------------------------------------------------------------------------------------------

function Invoke-Installer([string] $File, [string] $Arguments, [string] $Label, [switch] $Interactive) {
  Log "run: `"$File`" $Arguments"
  $start = @{ FilePath = $File; PassThru = $true }
  if ($Arguments) { $start.ArgumentList = $Arguments }
  $p = Start-Process @start
  $handle = $p.Handle # keeps ExitCode readable after the process ends
  $wait = $TimeoutSeconds
  if ($Interactive) { Invoke-UiDriver -Process $p; $wait = 15 }
  if (-not $p.WaitForExit($wait * 1000)) {
    Fail "$Label did not finish within $TimeoutSeconds s (open dialog?): killing it"
    Dump-Windows
    & taskkill.exe /F /T /PID $p.Id | Out-Null
    return $null
  }
  $p.WaitForExit()
  Log "$Label exit code: $($p.ExitCode)"
  return $p.ExitCode
}

function Start-App([string] $Exe) {
  Log "start app: $Exe"
  $p = Start-Process -FilePath $Exe -PassThru
  Start-Sleep -Seconds 10
  $p.Refresh()
  if ($p.HasExited) { Log "app exited early with $($p.ExitCode)"; return $false }
  Log "app alive after 10 s (pid $($p.Id))"
  return $true
}

# --- UI Automation (interactive mode) -----------------------------------------------------------------------------

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
# UI Automation's Invoke() on a Win32 button is a SendMessage: it blocks while the click handler runs, and NSIS's
# handlers run the old uninstaller (ExecWait) or open message boxes, which then nobody could answer. Buttons are
# clicked with a posted WM_COMMAND (BN_CLICKED) to their parent instead; radio buttons with BM_CLICK (no modal).
Add-Type -Namespace TT -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
[DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hWnd);
'@

function Click-Button($Element) {
  $hwnd = [IntPtr] $Element.Current.NativeWindowHandle
  $parent = [TT.Win32]::GetParent($hwnd)
  $id = [TT.Win32]::GetDlgCtrlID($hwnd)
  [TT.Win32]::PostMessage($parent, 0x0111, [IntPtr] ($id -band 0xFFFF), $hwnd) | Out-Null # WM_COMMAND, BN_CLICKED = 0
}

function Click-Radio($Element) {
  [TT.Win32]::SendMessage([IntPtr] $Element.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null # BM_CLICK
}
$UIA = [System.Windows.Automation.AutomationElement]
$TreeScope = [System.Windows.Automation.TreeScope]
$AnyCond = [System.Windows.Automation.Condition]::TrueCondition
$DialogClasses = @('#32770', 'MsiDialogCloseClass', 'MsiDialogNoCloseClass')

# Dialogs of the installers only (the runner image can show others, e.g. a paging-file notice).
function Get-DialogWindows {
  $UIA::RootElement.FindAll($TreeScope::Children, $AnyCond) | Where-Object {
    $proc = (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName
    ($DialogClasses -contains $_.Current.ClassName) -and ($proc -match '(?i)setup|uninstall|^un_|^au_|msiexec|timetrack|time-track')
  }
}

function Get-Texts($Window) {
  $Window.FindAll($TreeScope::Descendants, $AnyCond) | ForEach-Object {
    $n = $_.Current.Name
    if ($n) { '{0}:{1}' -f $_.Current.ControlType.ProgrammaticName.Replace('ControlType.', ''), $n.Trim() }
  }
}

function Dump-Windows {
  foreach ($w in (Get-DialogWindows)) {
    $proc = (Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName
    Log ("open window '{0}' ({1}): {2}" -f $w.Current.Name, $proc, ((Get-Texts $w) -join ' | '))
  }
}

# By name: UI Automation reports the controls of the 32-bit NSIS windows as "Pane", not Button / RadioButton.
function Find-Control($Window, [string] $Pattern) {
  $Window.FindAll($TreeScope::Descendants, $AnyCond) | Where-Object {
    $_.Current.NativeWindowHandle -ne 0 -and $_.Current.IsEnabled -and $_.Current.Name -match $Pattern
  } | Select-Object -First 1
}

function Invoke-UiDriver($Process) {
  # A user who accepts every default. After "Unable to uninstall!" the driver picks the second option of the reinstall
  # page (the workaround a user would try), and gives up (Cancel) when the same error comes back a third time.
  $seen = @{}
  $script:RadioClicked = @{}
  $unableCount = 0
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while (-not $Process.HasExited -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 2000
    foreach ($w in (Get-DialogWindows)) {
      try {
        $texts = @(Get-Texts $w)
        $proc = (Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName
        $signature = "$proc|$($w.Current.Name)|$($texts -join '|')"
        if (-not $seen.ContainsKey($signature)) {
          $seen[$signature] = $true
          $line = "dialog '{0}' ({1}): {2}" -f $w.Current.Name, $proc, ($texts -join ' | ')
          $script:Dialogs.Add($line)
          Log $line
        }
        $all = $texts -join "`n"
        if ($all -match 'Unable to uninstall') {
          $unableCount++
          Log "seen 'Unable to uninstall!' ($unableCount)"
        }
        if ($unableCount -ge 3) {
          $cancel = Find-Control $w '^Cancel$'
          if ($cancel) { Log 'click: Cancel (giving up)'; Click-Button $cancel; continue }
        }
        if ($unableCount -ge 1) {
          $radio = Find-Control $w "^(Do not uninstall|Don't uninstall)"
          if ($radio) {
            if (-not $script:RadioClicked.ContainsKey($signature)) {
              $script:RadioClicked[$signature] = $true
              Log "select: $($radio.Current.Name)"
              Click-Radio $radio
              Start-Sleep -Milliseconds 500
            }
          }
        }
        foreach ($pattern in '^Yes$', '^OK$', '^Next >$', '^Install$', '^Uninstall$', '^Finish$', '^Close$') {
          $button = Find-Control $w $pattern
          if ($button) {
            Log "click: $($button.Current.Name) in '$($w.Current.Name)'"
            Click-Button $button
            break
          }
        }
      } catch {
        # Windows come and go between the enumeration and the click.
      }
    }
  }
}

# --- Scenario -----------------------------------------------------------------------------------------------------

$newSetup = Get-ChildItem -Path $NewDir -Filter '*-setup.exe' -Recurse | Select-Object -First 1
if ($null -eq $newSetup) { throw "no *-setup.exe in $NewDir" }
$newVersion = [regex]::Match($newSetup.Name, '_(\d+\.\d+\.\d+[^_]*)_').Groups[1].Value
$sig = Get-ChildItem -Path $NewDir -Filter "$($newSetup.Name).sig" -Recurse | Select-Object -First 1
Log "new installer: $($newSetup.FullName) (version $newVersion, updater signature: $([bool] $sig))"
Log "scenario: old=$Old mode=$Mode appRunning=$AppRunning"

$oldMsi = Get-ChildItem -Path $OldDir -Filter '*.msi' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
$oldSetup = Get-ChildItem -Path $OldDir -Filter '*-setup.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1

Show-State 'clean machine' | Out-Null

if ($Old -in 'msi', 'both') {
  if ($null -eq $oldMsi) { throw "no .msi in $OldDir" }
  $code = Invoke-Installer 'msiexec.exe' "/i `"$($oldMsi.FullName)`" /qn /norestart /l*v `"$(Join-Path $OutDir 'old-msi-install.log')`"" 'old MSI install'
  if ($code -ne 0) { throw "old MSI install failed ($code)" }
}
if ($Old -in 'nsis', 'both') {
  if ($null -eq $oldSetup) { throw "no *-setup.exe in $OldDir" }
  $code = Invoke-Installer $oldSetup.FullName '/S' 'old NSIS install'
  if ($code -ne 0) { throw "old NSIS install failed ($code)" }
}
$before = Show-State 'old version installed'

$newBase = [version] [regex]::Match($newVersion, '^\d+\.\d+\.\d+').Value
$checkInstances = $newBase -ge [version] '0.5.1'
if ($checkInstances) {
  # What older versions could leave: the app's value for the old copy (0.1.0 MSI in Program Files, or the per-user
  # install), a second value under another name, and a per-machine value written by an elevated copy.
  $seedExe = $null
  foreach ($dir in (Get-InstallDirs)) { if (-not $seedExe) { $seedExe = Get-AppExe $dir } }
  if (-not $seedExe) { throw 'no old executable to seed start-at-login entries' }
  Log "start-at-login scenario: $Autostart"
  Set-RunEntry 'HKCU' $Product "$seedExe --hidden"
  switch ($Autostart) {
    'dupes' {
      Set-RunEntry 'HKCU' 'time-track-desktop' "`"$seedExe`" --hidden"
      Set-RunEntry 'HKLM' $Product "$seedExe --hidden"
    }
    'disabled' {
      Set-RunEntry 'HKCU' 'time-track-desktop' "`"$seedExe`" --hidden"
      Set-Approved 'HKCU' 'time-track-desktop' $DisabledMarker
    }
    'foreign' {
      Set-RunEntry 'HKCU' 'TimeTrack Vendor' "$Vendor\TimeTrack.exe"
      Set-RunEntry 'HKLM' $Product "`"$Vendor\TimeTrackAgent.exe`" --tray"
    }
  }
}

if ($AppRunning) {
  $oldExe = $null
  foreach ($dir in (Get-InstallDirs)) { if (-not $oldExe) { $oldExe = Get-AppExe $dir } }
  if (-not $oldExe) { throw 'no old executable to start' }
  if (-not (Start-App $oldExe)) { Fail 'the old app did not stay up before the upgrade' }
}

$arguments = switch ($Mode) { 'silent' { '/S' } 'update' { '/P /UPDATE' } 'interactive' { '' } }
$exitCode = Invoke-Installer $newSetup.FullName $arguments 'new installer' -Interactive:($Mode -eq 'interactive')
Start-Sleep -Seconds 3
$after = Show-State 'after the upgrade'

# --- Checks -------------------------------------------------------------------------------------------------------

if ($exitCode -ne 0) { Fail "new installer exit code $exitCode (expected 0)" }
$msiLeft = @($after | Where-Object { $_.UninstallString -match 'msiexec' })
if ($OldMsiStays) {
  Log "expected: the old MSI stays with /S ($($msiLeft.Count) MSI entry left)"
  if (@($after | Where-Object { $_.UninstallString -notmatch 'msiexec' }).Count -ne 1) { Fail 'expected exactly 1 per-user Uninstall entry' }
} else {
  if ($after.Count -ne 1) { Fail "$($after.Count) Uninstall entries for $Product (expected exactly 1)" }
  if ($msiLeft.Count -gt 0) { Fail "old MSI install still registered: $($msiLeft[0].DisplayVersion) under $($msiLeft[0].Hive)" }
  if (($Old -in 'msi', 'both') -and (Test-Path (Join-Path $env:ProgramFiles $Product))) { Fail "$env:ProgramFiles\$Product still exists" }
}
$current = @($after | Where-Object { $_.DisplayVersion -eq $newVersion })
if ($current.Count -ne 1) { Fail "no single Uninstall entry with version $newVersion" }
$newExe = Get-AppExe (Join-Path $env:LOCALAPPDATA $Product)
if (-not $newExe) {
  Fail "no executable in $env:LOCALAPPDATA\$Product"
} else {
  $fileVersion = (Get-Item $newExe).VersionInfo.ProductVersion
  Log "installed executable: $newExe ($fileVersion)"
  if ($fileVersion -notlike "$newVersion*") { Fail "installed executable is $fileVersion, expected $newVersion" }
  Get-AppProcesses | ForEach-Object { Log "stopping $($_.Id) before the start check"; Stop-Process -Id $_.Id -Force }
  if (-not (Start-App $newExe)) { Fail 'the upgraded app does not start' }
  elseif ($checkInstances) {
    # Single instance: a second launch (here with --hidden, like a duplicate start-at-login entry) exits at once.
    Log "second launch: $newExe --hidden"
    $second = Start-Process -FilePath $newExe -ArgumentList '--hidden' -PassThru
    $secondHandle = $second.Handle
    if (-not $second.WaitForExit(20000)) {
      Fail 'a second launch kept running next to the first one (two tray icons)'
    } else {
      Log "second launch exited with $($second.ExitCode)"
      if ($second.ExitCode -ne 0) { Fail "second launch exit code $($second.ExitCode) (expected 0)" }
    }
    $alive = @(Get-AppProcesses)
    Log "processes after the second launch: $($alive.Count)"
    if ($alive.Count -ne 1) { Fail "$($alive.Count) TimeTrack processes after a second launch (expected 1)" }
    # Start-at-login: one HKCU "TimeTrack" value for the new executable, path quoted (the app cleaned up at start).
    $all = Get-RunEntries
    foreach ($r in $all) { Log ("  start-at-login {0}\{1} = {2}" -f $r.Hive, $r.Name, $r.Command) }
    $runs = @($all | Where-Object { -not $_.Command.TrimStart('"').StartsWith($Vendor, [StringComparison]::OrdinalIgnoreCase) })
    if ($runs.Count -ne 1) {
      Fail "$($runs.Count) start-at-login entries for $Product (expected exactly 1)"
    } elseif ($runs[0].Hive -ne 'HKCU' -or $runs[0].Name -ne $Product -or -not $runs[0].Command.StartsWith("`"$newExe`"", [StringComparison]::OrdinalIgnoreCase)) {
      Fail "start-at-login entry is $($runs[0].Hive)\$($runs[0].Name) = $($runs[0].Command) (expected HKCU\$Product = `"$newExe`" --hidden)"
    }
    $state = Get-Approved 'HKCU' $Product
    Log ("  Task Manager state HKCU\{0} = {1}" -f $Product, $(if ($null -eq $state) { '(none)' } else { [BitConverter]::ToString($state) }))
    switch ($Autostart) {
      'disabled' {
        if (-not (Test-Disabled $state)) { Fail 'the entry disabled in Task Manager is enabled again after the clean-up' }
        if ($null -ne (Get-Approved 'HKCU' 'time-track-desktop')) { Fail 'the removed entry left its Task Manager state behind' }
      }
      'foreign' {
        if ((Get-RunValue 'HKCU' 'TimeTrack Vendor') -ne "$Vendor\TimeTrack.exe") { Fail "another vendor's HKCU entry 'TimeTrack Vendor' was changed or removed" }
        if ((Get-RunValue 'HKLM' $Product) -ne "`"$Vendor\TimeTrackAgent.exe`" --tray") { Fail "another vendor's HKLM entry '$Product' was changed or removed" }
        if (Test-Disabled $state) { Fail 'start-at-login is disabled, expected enabled' }
      }
      default { if (Test-Disabled $state) { Fail 'start-at-login is disabled, expected enabled' } }
    }
  }
  Get-AppProcesses | ForEach-Object { Stop-Process -Id $_.Id -Force }
}

$result = [pscustomobject] @{
  old         = $Old
  mode        = $Mode
  appRunning  = [bool] $AppRunning
  newVersion  = $newVersion
  runEntries  = $(if ($checkInstances) { Get-RunEntries } else { @() })
  exitCode    = $exitCode
  before      = $before
  after       = $after
  dialogs     = $script:Dialogs
  failures    = $script:Failures
}
$result | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $OutDir 'result.json')

$md = @("### old=$Old, mode=$Mode, app running=$([bool] $AppRunning) → $newVersion", '',
  "- new installer exit code: ``$exitCode``",
  "- Uninstall entries after: $($after.Count) ($((@($after | ForEach-Object { "$($_.Hive) $($_.DisplayVersion) $($_.Publisher)" })) -join '; '))")
foreach ($d in $script:Dialogs) { $md += "- $d" }
if ($script:Failures.Count -eq 0) { $md += '- **PASS**' } else { foreach ($f in $script:Failures) { $md += "- **FAIL**: $f" } }
$md -join "`n" | Set-Content -Path (Join-Path $OutDir 'summary.md')
if ($env:GITHUB_STEP_SUMMARY) { $md -join "`n" | Add-Content -Path $env:GITHUB_STEP_SUMMARY }

if ($script:Failures.Count -gt 0) { exit 1 }
exit 0
