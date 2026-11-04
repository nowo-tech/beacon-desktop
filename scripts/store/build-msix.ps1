<#
.SYNOPSIS
  Builds the Microsoft Store package (MSIX) of TimeTrack on Windows. Zero cost: the Store re-signs MSIX packages.

.DESCRIPTION
  1. Builds the Store variant: TIMETRACK_CHANNEL=store (no in-app updater, no autostart switch), tauri.store.conf.json
     (no updater artifacts, no updater configuration), no installer (--no-bundle).
  2. Stages TimeTrack.exe, the Store logos (`tauri icon`) and AppxManifest.xml (scripts/store/msix-manifest.mjs).
  3. Packs out\store\TimeTrack_<version>_<arch>.msix with MakeAppx (Windows SDK).
  Upload that file in Partner Center (docs/RELEASE-PLAN-0.4.0.md, "Partner Center, every version"). It is unsigned:
  the Store signs it. To try it locally first: Settings → System → For developers → Developer Mode on, then
  `Add-AppxPackage -Register out\store\stage\AppxManifest.xml` (and `Get-AppxPackage *TimeTrack* | Remove-AppxPackage`).

  Needs: Node 22.18+, pnpm, Rust (stable, MSVC), the Windows 10/11 SDK (MakeAppx.exe), and the three values of
  Partner Center → TimeTrack for Beacon → Product management → Product identity:
    $env:MSIX_IDENTITY_NAME            Package/Identity/Name
    $env:MSIX_PUBLISHER                Package/Identity/Publisher (CN=…)
    $env:MSIX_PUBLISHER_DISPLAY_NAME   Package/Properties/PublisherDisplayName
  Optional: $env:TIMETRACK_STORE_URL = https://apps.microsoft.com/detail/<Store ID> (the "Open Microsoft Store" button;
  without it the button opens Beacon's Apps page), $env:BEACON_URL (prefilled server).

.EXAMPLE
  pwsh scripts/store/build-msix.ps1
  pwsh scripts/store/build-msix.ps1 -Arch arm64
#>
param(
  [ValidateSet('x64', 'arm64')] [string] $Arch = 'x64',
  [switch] $SkipBuild
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root

foreach ($name in 'MSIX_IDENTITY_NAME', 'MSIX_PUBLISHER', 'MSIX_PUBLISHER_DISPLAY_NAME') {
  if (-not [Environment]::GetEnvironmentVariable($name)) { throw "$name is not set (Partner Center → Product identity)." }
}
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$rustTarget = @{ x64 = 'x86_64-pc-windows-msvc'; arm64 = 'aarch64-pc-windows-msvc' }[$Arch]

if (-not $SkipBuild) {
  $env:TIMETRACK_CHANNEL = 'store'
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE) { throw 'pnpm install failed' }
  pnpm tauri build --no-bundle --target $rustTarget --config src-tauri/tauri.store.conf.json
  if ($LASTEXITCODE) { throw 'tauri build failed' }
}

$release = Join-Path $root "src-tauri\target\$rustTarget\release"
$exe = @('TimeTrack.exe', 'time-track-desktop.exe') | ForEach-Object { Join-Path $release $_ } | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { throw "No TimeTrack.exe / time-track-desktop.exe in $release" }

$out = Join-Path $root 'out\store'
$stage = Join-Path $out 'stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'Assets') | Out-Null
Copy-Item $exe (Join-Path $stage 'TimeTrack.exe')

# Store logos (Square44x44Logo, Square150x150Logo, StoreLogo, …) from the app icon source.
$icons = Join-Path $out 'icons'
pnpm tauri icon scripts/icons/app-icon-1024.png --output $icons
if ($LASTEXITCODE) { throw 'tauri icon failed' }
Get-ChildItem $icons -Filter '*Logo.png' | Copy-Item -Destination (Join-Path $stage 'Assets')

node scripts/store/msix-manifest.mjs $Arch | Set-Content -Encoding utf8 (Join-Path $stage 'AppxManifest.xml')
if ($LASTEXITCODE) { throw 'msix-manifest failed' }

$makeappx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $makeappx) { throw 'MakeAppx.exe not found: install the Windows SDK (free, https://developer.microsoft.com/windows/downloads/windows-sdk/).' }
$package = Join-Path $out "TimeTrack_${version}_$Arch.msix"
& $makeappx.FullName pack /d $stage /p $package /o
if ($LASTEXITCODE) { throw 'MakeAppx pack failed' }
Write-Host "MSIX ready (unsigned, the Store signs it): $package"
