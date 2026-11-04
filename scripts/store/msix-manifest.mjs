/**
 * AppxManifest.xml of the Microsoft Store (MSIX) package (docs/RELEASE-PLAN-0.4.0.md, "Microsoft Store").
 *
 * The Store build is the Tauri binary built with `TIMETRACK_CHANNEL=store` (no in-app updater) packed with MakeAppx.
 * The Store re-signs MSIX packages with a Microsoft certificate after certification, so no code-signing certificate is
 * needed. The identity values come from Partner Center → the product → Product identity.
 *
 * CLI (prints the manifest):
 *   MSIX_IDENTITY_NAME=… MSIX_PUBLISHER="CN=…" MSIX_PUBLISHER_DISPLAY_NAME=… node scripts/store/msix-manifest.mjs [arch]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DISPLAY_NAME = 'TimeTrack for Beacon';
export const DESCRIPTION = 'Start, stop and switch your Beacon time tracking from the tray. Records only the time you choose to track.';
export const EXECUTABLE = 'TimeTrack.exe';
/** Windows 10 1809: the oldest build where MSIX full-trust desktop apps and WebView2 are both supported. */
export const MIN_WINDOWS = '10.0.17763.0';
export const MAX_TESTED = '10.0.26100.0';
export const ARCHES = ['x64', 'arm64'];

/**
 * App version → MSIX package version: `MAJOR+1.MINOR.PATCH.0` (`0.4.0` → `1.4.0.0`, `1.0.0` → `2.0.0.0`). The Store
 * requires a first part of at least 1, reserves the fourth (must be 0) and needs every new package to be higher; the
 * +1 keeps the order forever. Users never see it: the app shows its own version (About). Pre-releases are refused.
 */
export function msixVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (match === null) {
    throw new Error(`MSIX needs a MAJOR.MINOR.PATCH release version, not "${version}"`);
  }
  const parts = [Number(match[1]) + 1, Number(match[2]), Number(match[3])];
  if (parts.some((part) => part > 65535)) {
    throw new Error(`MSIX version parts must be at most 65535: "${version}"`);
  }
  return `${parts.join('.')}.0`;
}

export function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

/**
 * @param {{identityName: string, publisher: string, publisherDisplayName: string, version: string, arch?: string,
 *          displayName?: string}} input
 */
export function buildManifest({ identityName, publisher, publisherDisplayName, version, arch = 'x64', displayName = DISPLAY_NAME }) {
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(identityName ?? '')) {
    throw new Error('MSIX_IDENTITY_NAME must be Package/Identity/Name from Partner Center (3–50 of A-Z a-z 0-9 . -)');
  }
  if (!/^CN=[^<>&"]{1,8000}$/.test(publisher ?? '')) {
    throw new Error('MSIX_PUBLISHER must be Package/Identity/Publisher from Partner Center (starts with "CN=")');
  }
  if (typeof publisherDisplayName !== 'string' || publisherDisplayName.trim() === '') {
    throw new Error('MSIX_PUBLISHER_DISPLAY_NAME must be Package/Properties/PublisherDisplayName from Partner Center');
  }
  if (!ARCHES.includes(arch)) {
    throw new Error(`arch must be ${ARCHES.join(' or ')}`);
  }
  const e = escapeXml;
  return `<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         IgnorableNamespaces="uap rescap">
  <Identity Name="${e(identityName)}" Publisher="${e(publisher)}" Version="${msixVersion(version)}" ProcessorArchitecture="${arch}" />
  <Properties>
    <DisplayName>${e(displayName)}</DisplayName>
    <PublisherDisplayName>${e(publisherDisplayName.trim())}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
    <Description>${e(DESCRIPTION)}</Description>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="${MIN_WINDOWS}" MaxVersionTested="${MAX_TESTED}" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
    <Resource Language="es-es" />
  </Resources>
  <Applications>
    <Application Id="TimeTrack" Executable="${EXECUTABLE}" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="${e(displayName)}" Description="${e(DESCRIPTION)}" BackgroundColor="transparent"
                          Square150x150Logo="Assets\\Square150x150Logo.png" Square44x44Logo="Assets\\Square44x44Logo.png" />
    </Application>
  </Applications>
  <Capabilities>
    <Capability Name="internetClient" />
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`;
}

/* c8 ignore start */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    process.stdout.write(
      buildManifest({
        identityName: process.env.MSIX_IDENTITY_NAME,
        publisher: process.env.MSIX_PUBLISHER,
        publisherDisplayName: process.env.MSIX_PUBLISHER_DISPLAY_NAME,
        displayName: process.env.MSIX_DISPLAY_NAME || DISPLAY_NAME,
        version,
        arch: process.argv[2] ?? 'x64',
      }),
    );
  } catch (error) {
    console.error(`msix-manifest: ${error.message}`);
    process.exit(1);
  }
}
/* c8 ignore stop */
