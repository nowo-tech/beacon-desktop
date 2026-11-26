import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PREFIX } from '../../scripts/release/channel.mjs';
import { buildManifest } from '../../scripts/store/msix-manifest.mjs';
import { MEETINGS_KEY } from '../../src/lib/meetingReminders';
import { LOCAL_KEYS, SETTINGS_TAB_KEY } from '../../src/lib/settings';
import en from '../../src/i18n/en.json';
import es from '../../src/i18n/es.json';

/**
 * Beacon Desktop 0.9.0 renamed only what people see (docs/design/BEACON_DESKTOP.md §2.2 option A, owner Q-BD-1 = A).
 * Every installed TimeTrack 0.x must keep updating in place, keep its sign-in and its settings: the ids below decide
 * that, so they are frozen here. Changing one is a migration (option B or C), never a rename.
 */
const read = (path: string) => readFileSync(path, 'utf8');
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
const cargo = read('src-tauri/Cargo.toml');
const lib = read('src-tauri/src/lib.rs');

/** The release updater public key (minisign). Never rotated as part of the rename: old copies would refuse updates. */
const UPDATER_PUBKEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEIzOUU3RjkwNkM5MjM4OTMKUldTVE9KSnNrSCtlc3hMOHlWQlo0a3BkUlVaMHZ4b2ZpbWR5b3ZBamttMS9zTFdZa2Joa0NXNGUK';

describe('Q-BD-1 option A: technical ids unchanged by the rename', () => {
  it('keeps the bundle identifier (app data, web view data, macOS bundle id, Windows AUMID)', () => {
    expect(conf.identifier).toBe('tech.nowo.timetrack');
    expect(read('src-tauri/src/notify.rs')).toContain('windows_aumid(&exe, &app.config().identifier)');
  });

  it('keeps productName and the binary: install folder, Uninstall key, .app and Debian package names', () => {
    expect(conf.productName).toBe('TimeTrack');
    expect(conf.mainBinaryName).toBeUndefined();
    expect(cargo).toMatch(/^\[package\]\nname = "time-track-desktop"$/m);
    expect(cargo).toMatch(/^\[lib\]\nname = "time_track_desktop_lib"$/m);
    expect(JSON.parse(read('package.json')).name).toBe('time-track-desktop');
    expect(read('src-tauri/src/autostart.rs')).toContain('pub const INSTALL_DIR: &str = "TimeTrack";');
  });

  it('no channel config overrides the ids', () => {
    for (const file of ['src-tauri/tauri.store.conf.json', 'src-tauri/tauri.unsigned.conf.json']) {
      const overlay = JSON.parse(read(file));
      expect(overlay.identifier, file).toBeUndefined();
      expect(overlay.productName, file).toBeUndefined();
      expect(overlay.mainBinaryName, file).toBeUndefined();
    }
  });

  it('keeps the keychain entry of the session token', () => {
    const secret = read('src-tauri/src/secret.rs');
    expect(secret).toContain('const KEYCHAIN_SERVICE: &str = "tech.nowo.time-track-desktop";');
    expect(secret).toContain('const KEYCHAIN_USER: &str = "session-token";');
  });

  it('keeps the localStorage keys', () => {
    expect(LOCAL_KEYS).toEqual(['time-track-desktop', 'time-track-desktop.queue', 'time-track-desktop.meetings', 'time-track-desktop.settingsTab']);
    expect(MEETINGS_KEY).toBe('time-track-desktop.meetings');
    expect(SETTINGS_TAB_KEY).toBe('time-track-desktop.settingsTab');
  });

  it('keeps the updater public key, the runtime endpoint and the S3 prefix', () => {
    expect(conf.plugins.updater.pubkey).toBe(UPDATER_PUBKEY);
    expect(conf.plugins.updater.endpoints).toEqual([]);
    expect(conf.plugins.updater.requireSignedVersion).toBe(true);
    expect(lib).toContain(
      '"{}/api/time-track/updates/desktop/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}?bundle_type={{{{bundle_type}}}}"',
    );
    expect(PREFIX).toBe('time-track-clients');
    expect(read('scripts/release/s3-put.sh')).toContain('S3_CLIENTS_PREFIX:-time-track-clients');
  });

  it('keeps the Windows installer keys and the Store identity', () => {
    const hooks = read('src-tauri/windows/installer-hooks.nsh');
    expect(hooks).toContain('!define TT_PRODUCT "TimeTrack"');
    expect(hooks).toContain('!define TT_KEY "Software\\nowo.tech\\TimeTrack"');
    expect(conf.bundle.publisher).toBe('nowo.tech');
    const xml = buildManifest({ identityName: 'X.TimeTrack', publisher: 'CN=X', publisherDisplayName: 'nowo.tech', version: '0.9.0' });
    expect(xml).toContain('<Application Id="TimeTrack" Executable="TimeTrack.exe"');
  });
});

describe('Q-BD-1 option A: the visible name is "Beacon Desktop"', () => {
  it('in the window titles, the tray, the in-app name and the About text', () => {
    expect(conf.app.windows[0].title).toBe('Beacon Desktop');
    expect(read('index.html')).toContain('<title>Beacon Desktop</title>');
    expect(lib).toContain('pub(crate) const APP_DISPLAY_NAME: &str = "Beacon Desktop";');
    expect(lib).toContain('.tooltip(APP_DISPLAY_NAME)');
    for (const messages of [en, es]) {
      expect(messages.appName).toBe('Beacon Desktop');
      expect(messages.about).toContain('Beacon Desktop');
      expect(messages.aboutText).toContain('Beacon Desktop {version}');
      expect(messages.trayTooltipIdle).toMatch(/^Beacon Desktop — /);
    }
  });

  it('in the shortcuts and the installed-apps lists, never through an id', () => {
    const hooks = read('src-tauri/windows/installer-hooks.nsh');
    expect(hooks).toContain('!define TT_DISPLAY_NAME "Beacon Desktop"');
    expect(hooks).toContain('WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${TT_DISPLAY_NAME}"');
    expect(hooks).toContain('!macro NSIS_HOOK_PREUNINSTALL');

    const template = `src-tauri/${conf.bundle.linux.deb.desktopTemplate}`;
    expect(existsSync(template)).toBe(true);
    expect(read(template)).toMatch(/^Name=Beacon Desktop$/m);
    expect(read(template)).toMatch(/^StartupWMClass=\{\{exec\}\}$/m);

    // macOS: only CFBundleDisplayName. CFBundleName, the executable and the bundle id follow the config.
    const plist = read('src-tauri/Info.plist');
    expect(plist).toMatch(/<key>CFBundleDisplayName<\/key>\s*<string>Beacon Desktop<\/string>/);
    expect([...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])).toEqual(['CFBundleDisplayName']);
  });
});

describe('s3-put.sh prefix guard', () => {
  // A stub `aws` on PATH: the guard runs before it, so a rejected key never reaches it.
  const bin = mkdtempSync(join(tmpdir(), 's3put-'));
  writeFileSync(join(bin, 'aws'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(bin, 'aws'), 0o755);
  const run = (key: string, prefix?: string) =>
    spawnSync('bash', ['scripts/release/s3-put.sh', 'package.json', key], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        TIME_TRACK_S3_ENDPOINT: 'http://x',
        TIME_TRACK_S3_BUCKET: 'b',
        TIME_TRACK_S3_ACCESS_KEY_ID: 'k',
        TIME_TRACK_S3_SECRET_ACCESS_KEY: 's',
        ...(prefix === undefined ? {} : { S3_CLIENTS_PREFIX: prefix }),
      },
    });

  it('accepts the default prefix and rejects beacon-clients keys by default', () => {
    expect(run('time-track-clients/desktop/1.0.0/a').status).toBe(0);
    expect(run('beacon-clients/desktop/1.0.0/a').status).toBe(1);
  });

  it('follows S3_CLIENTS_PREFIX=beacon-clients', () => {
    expect(run('beacon-clients/desktop/1.0.0/a', 'beacon-clients').status).toBe(0);
    expect(run('time-track-clients/desktop/1.0.0/a', 'beacon-clients').status).toBe(1);
  });

  it('rejects an invalid prefix, traversal and absolute keys', () => {
    const bad = run('evil/desktop/a', 'evil');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('invalid S3_CLIENTS_PREFIX');
    expect(run('time-track-clients/../x').status).toBe(1);
    expect(run('/time-track-clients/x').status).toBe(1);
  });
});
