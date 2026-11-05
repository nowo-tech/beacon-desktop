import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkPinExpiry, DEFAULT_MIN_DAYS, parseArgs } from '../../scripts/release/check-pin-expiry.mjs';
import { checkUpdaterKey, describePubkey, PLACEHOLDER } from '../../scripts/release/check-updater-key.mjs';
import { buildManifest, escapeXml, msixVersion } from '../../scripts/store/msix-manifest.mjs';

/** Shape of a `tauri signer generate` public key (base64 of the minisign .pub text). Made up: not a real key. */
const SHAPED_KEY = Buffer.from(`untrusted comment: minisign public key: 0123456789ABCDEF\nRW${'Q'.repeat(54)}\n`).toString('base64');
const config = (pubkey?: string) => ({ plugins: { updater: pubkey === undefined ? undefined : { pubkey } } });

describe('updater key release check', () => {
  it('the committed config carries the owner\'s updater public key, and the Rust side knows the placeholder marker', () => {
    const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    expect(conf.plugins.updater.pubkey).not.toBe(PLACEHOLDER);
    expect(describePubkey(conf.plugins.updater.pubkey)).toBe('B39E7F906C923893');
    expect(checkUpdaterKey({ config: conf, env: {} })).toMatchObject({ ok: true, level: 'ok' });
    expect(conf.bundle.createUpdaterArtifacts).toBe(true);
    expect(conf.bundle.windows.nsis.installMode).toBe('currentUser');
    expect(conf.bundle.targets).not.toContain('msi');
    expect(conf.build.beforeBuildCommand).toContain('check-updater-key.mjs');
    expect(readFileSync('src-tauri/src/lib.rs', 'utf8')).toContain(`const PUBKEY_PLACEHOLDER: &str = "${PLACEHOLDER}";`);
    const store = JSON.parse(readFileSync('src-tauri/tauri.store.conf.json', 'utf8'));
    expect(store.plugins.updater).toBeNull();
    expect(store.bundle.createUpdaterArtifacts).toBe(false);
  });

  it('fails a release build while the placeholder is there', () => {
    const result = checkUpdaterKey({ config: config(PLACEHOLDER), env: {} });
    expect(result).toMatchObject({ ok: false, level: 'error' });
    expect(result.message).toContain('placeholder');
    expect(checkUpdaterKey({ config: config(''), env: {} }).ok).toBe(false);
    expect(checkUpdaterKey({ config: {}, env: { TIMETRACK_CHANNEL: 'direct' } }).ok).toBe(false);
  });

  it('allows debug, explicit unsigned and Store builds without a key', () => {
    expect(checkUpdaterKey({ config: config(PLACEHOLDER), env: { TAURI_ENV_DEBUG: 'true' } })).toMatchObject({ ok: true, level: 'warn' });
    expect(checkUpdaterKey({ config: config(PLACEHOLDER), env: { TIMETRACK_ALLOW_UNSIGNED: '1' } })).toMatchObject({ ok: true, level: 'warn' });
    expect(checkUpdaterKey({ config: config(PLACEHOLDER), env: { TIMETRACK_CHANNEL: 'store' } })).toMatchObject({ ok: true, level: 'ok' });
    expect(checkUpdaterKey({ config: config(PLACEHOLDER), env: { TIMETRACK_CHANNEL: 'beta' } })).toMatchObject({ ok: false });
  });

  it('accepts a minisign public key from the config or TAURI_UPDATER_PUBKEY (which wins)', () => {
    expect(describePubkey(SHAPED_KEY)).toBe('0123456789ABCDEF');
    expect(checkUpdaterKey({ config: config(SHAPED_KEY), env: {} })).toMatchObject({ ok: true, message: expect.stringContaining('tauri.conf.json') });
    expect(checkUpdaterKey({ config: config(PLACEHOLDER), env: { TAURI_UPDATER_PUBKEY: ` ${SHAPED_KEY}\n` } })).toMatchObject({
      ok: true,
      message: expect.stringContaining('TAURI_UPDATER_PUBKEY'),
    });
  });

  it('refuses a private key, a raw key line or garbage', () => {
    const privateShaped = Buffer.from('untrusted comment: rsign encrypted secret key\nRWRTY0Iy'.padEnd(120, 'A')).toString('base64');
    expect(checkUpdaterKey({ config: config(privateShaped), env: {} })).toMatchObject({ ok: false, level: 'error' });
    expect(checkUpdaterKey({ config: config('RWQ' + 'Q'.repeat(53)), env: {} }).ok).toBe(false);
    expect(checkUpdaterKey({ config: config('not base64!'), env: {} }).message).toContain('not base64');
    expect(() => describePubkey(undefined)).toThrow();
  });
});

describe('MSIX manifest (Microsoft Store)', () => {
  const identity = { identityName: '12345NowoTech.TimeTrackforBeacon', publisher: 'CN=ABCDEF12-3456-7890-ABCD-EF1234567890', publisherDisplayName: 'nowo.tech' };

  it('maps the version to the Store format and refuses pre-releases', () => {
    // First part ≥ 1 (Store rule), fourth part 0, order kept.
    expect(msixVersion('0.4.0')).toBe('1.4.0.0');
    expect(msixVersion('0.4.1')).toBe('1.4.1.0');
    expect(msixVersion('1.0.0')).toBe('2.0.0.0');
    expect(msixVersion('12.0.65535')).toBe('13.0.65535.0');
    expect(() => msixVersion('65535.0.0')).toThrow('65535');
    expect(() => msixVersion('0.4.0-rc.1')).toThrow('MAJOR.MINOR.PATCH');
    expect(() => msixVersion('0.70000.0')).toThrow('65535');
  });

  it('builds a full-trust desktop package with the Partner Center identity', () => {
    const xml = buildManifest({ ...identity, version: '0.4.0' });
    expect(xml).toContain('<Identity Name="12345NowoTech.TimeTrackforBeacon" Publisher="CN=ABCDEF12-3456-7890-ABCD-EF1234567890" Version="1.4.0.0" ProcessorArchitecture="x64" />');
    expect(xml).toContain('EntryPoint="Windows.FullTrustApplication"');
    expect(xml).toContain('<rescap:Capability Name="runFullTrust" />');
    expect(xml).toContain('<DisplayName>TimeTrack for Beacon</DisplayName>');
    expect(xml).toContain('<Resource Language="es-es" />');
    expect(xml).toContain('MinVersion="10.0.17763.0"');
    expect(buildManifest({ ...identity, version: '0.4.0', arch: 'arm64', displayName: 'A & B' })).toContain('<DisplayName>A &amp; B</DisplayName>');
  });

  it('refuses missing or malformed identity values', () => {
    expect(() => buildManifest({ ...identity, identityName: 'x', version: '0.4.0' })).toThrow('MSIX_IDENTITY_NAME');
    expect(() => buildManifest({ ...identity, publisher: 'nowo', version: '0.4.0' })).toThrow('MSIX_PUBLISHER');
    expect(() => buildManifest({ ...identity, publisherDisplayName: ' ', version: '0.4.0' })).toThrow('MSIX_PUBLISHER_DISPLAY_NAME');
    expect(() => buildManifest({ ...identity, version: '0.4.0', arch: 'x86' })).toThrow('arch');
    expect(escapeXml(`<"'&>`)).toBe('&lt;&quot;&apos;&amp;&gt;');
  });
});

describe('pin set expiry tripwire (FY-L2)', () => {
  const pins = (expires: unknown) => ({ version: 1, expires, hosts: ['beacon.example.test'], pins: [{ sha256: 'x', label: 'y' }] });
  const now = new Date('2026-11-05T12:00:00Z');

  it('passes the shipped pin set with the release threshold', () => {
    const shipped = JSON.parse(readFileSync('src-tauri/pins.json', 'utf8'));
    expect(checkPinExpiry({ pins: shipped, now, minDays: 180 })).toMatchObject({ ok: true });
  });

  it('fails inside the threshold and after expiry, passes outside it', () => {
    expect(checkPinExpiry({ pins: pins('2027-02-01'), now })).toMatchObject({ ok: false, daysLeft: 87 });
    expect(checkPinExpiry({ pins: pins('2027-02-01'), now }).message).toContain('rotate it');
    expect(checkPinExpiry({ pins: pins('2026-11-01'), now }).ok).toBe(false);
    expect(checkPinExpiry({ pins: pins('2027-02-05'), now })).toMatchObject({ ok: true, daysLeft: 91 });
    expect(checkPinExpiry({ pins: pins('2027-02-05'), now, minDays: 180 }).ok).toBe(false);
    expect(DEFAULT_MIN_DAYS).toBe(90);
  });

  it('fails on a broken pin file', () => {
    for (const bad of [null, {}, { ...pins('2028-05-01'), hosts: [] }, { ...pins('2028-05-01'), pins: [] }, { ...pins('2028-05-01'), version: '1' }]) {
      expect(checkPinExpiry({ pins: bad, now }).ok).toBe(false);
    }
    for (const date of ['2028-02-30', '28-05-01', 20280501, undefined]) {
      expect(checkPinExpiry({ pins: pins(date), now })).toMatchObject({ ok: false, daysLeft: null });
    }
  });

  it('reads --min-days and the path', () => {
    expect(parseArgs([])).toEqual({ minDays: 90, path: null });
    expect(parseArgs(['--min-days', '180', 'x.json'])).toEqual({ minDays: 180, path: 'x.json' });
    expect(() => parseArgs(['--min-days', 'soon'])).toThrow('whole number');
    expect(() => parseArgs(['--min-days', '-1'])).toThrow('whole number');
  });
});

describe('Windows installer upgrades', () => {
  const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const hooks = readFileSync(`src-tauri/${conf.bundle.windows.nsis.installerHooks}`, 'utf8');

  it('keeps what an in-place upgrade depends on: identifier, publisher, per-user NSIS', () => {
    // Changing any of these makes the next installer look for the previous install in the wrong place (0.4.0 changed
    // the publisher and its reinstall page could not uninstall 0.1.0).
    expect(conf.identifier).toBe('tech.nowo.timetrack');
    expect(conf.productName).toBe('TimeTrack');
    expect(conf.bundle.publisher).toBe('nowo.tech');
    expect(conf.bundle.windows.nsis.installMode).toBe('currentUser');
    expect(conf.plugins.updater.windows.installMode).toBe('passive');
  });

  it('the NSIS hooks know the current and the 0.1.0 registry keys', () => {
    expect(hooks).toContain(`!define TT_PRODUCT "${conf.productName}"`);
    expect(hooks).toContain(`!define TT_KEY "Software\\${conf.bundle.publisher}\\${conf.productName}"`);
    // 0.1.0 had no bundle.publisher: Tauri used the identifier's second part.
    expect(hooks).toContain(`!define TT_LEGACY_KEY "Software\\${conf.identifier.split('.')[1]}\\${conf.productName}"`);
    expect(hooks).toContain('!macro NSIS_HOOK_POSTINSTALL');
  });
});
