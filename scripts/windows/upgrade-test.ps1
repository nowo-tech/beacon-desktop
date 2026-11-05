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

  Then checks: installer exit code, a single "TimeTrack" entry under the Uninstall keys (HKCU and HKLM, both views)
  carrying the new version, no MSI left behind, the installed executable's version and that the app starts. Writes
  result.json and a Markdown summary to -OutDir (and to $env:GITHUB_STEP_SUMMARY when set). Exit code 1 when a check
  failed. Needs Windows PowerShell 5.1 (UI Automation assemblies).
#>
param(
  [Parameter(Mandatory)] [ValidateSet('msi', 'nsis', 'both', 'none')] [string] $Old,
  [Parameter(Mandatory)] [string] $OldDir,
  [Parameter(Mandatory)] [string] $NewDir,
  [Parameter(Mandatory)] [ValidateSet('silent', 'update', 'interactive')] [string] $Mode,
  [switch] $AppRunning,
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
if ($after.Count -ne 1) { Fail "$($after.Count) Uninstall entries for $Product (expected exactly 1)" }
$msiLeft = @($after | Where-Object { $_.UninstallString -match 'msiexec' })
if ($msiLeft.Count -gt 0) { Fail "old MSI install still registered: $($msiLeft[0].DisplayVersion) under $($msiLeft[0].Hive)" }
if (($Old -in 'msi', 'both') -and (Test-Path (Join-Path $env:ProgramFiles $Product))) { Fail "$env:ProgramFiles\$Product still exists" }
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
  Get-AppProcesses | ForEach-Object { Stop-Process -Id $_.Id -Force }
}

$result = [pscustomobject] @{
  old         = $Old
  mode        = $Mode
  appRunning  = [bool] $AppRunning
  newVersion  = $newVersion
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
