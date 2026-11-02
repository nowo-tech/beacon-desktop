import { describe, expect, it } from 'vitest';
import { buildStable, channelKey, compareVersions, describeFile, notesFromChangelog, objectKey, parseFragments } from '../../scripts/release/channel.mjs';

describe('release channel', () => {
  it('builds keys and file entries', () => {
    expect(objectKey('chromium', '0.1.0', 'dist/abc.crx')).toBe('time-track-clients/chromium/0.1.0/abc.crx');
    expect(objectKey('desktop', '0.1.0', 'TimeTrack 0.1.0.msi')).toBe('time-track-clients/desktop/0.1.0/TimeTrack_0.1.0.msi');
    expect(channelKey('firefox')).toBe('time-track-clients/firefox/channel/stable.json');
    expect(() => objectKey('safari', '0.1.0', 'x')).toThrow(/Unknown app/);
    expect(() => objectKey('desktop', 'v1', 'x')).toThrow(/Invalid version/);
    expect(() => objectKey('desktop', '0.1.0', 'a;b')).toThrow(/Unsafe/);
    expect(() => channelKey('x')).toThrow();
    const entry = describeFile({
      app: 'desktop', version: '0.1.0', target: 'linux', arch: 'x86_64', kind: 'updater',
      file: 'a.AppImage', content: Buffer.from('abc'), signature: ' sig\n',
    });
    expect(entry).toEqual({
      target: 'linux', arch: 'x86_64', kind: 'updater', key: 'time-track-clients/desktop/0.1.0/a.AppImage',
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', signature: 'sig',
    });
    expect(() => describeFile({ target: 'linux', arch: 'x86_64', app: 'desktop', version: '0.1.0', kind: 'zip', file: 'a', content: Buffer.from('') })).toThrow(/kind/);
    expect(() => describeFile({ app: 'desktop', version: '0.1.0', target: '', arch: '', kind: 'xpi', file: 'a', content: Buffer.from('') })).toThrow(/required/);
  });

  it('builds stable.json and extracts changelog notes', () => {
    const changelog = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-02\n\n### Added\n- First\n\n## [0.0.1]\n- old\n';
    expect(notesFromChangelog(changelog, '0.1.0')).toBe('### Added\n- First');
    expect(notesFromChangelog('## 0.2.0\nlast', '0.2.0')).toBe('last');
    expect(notesFromChangelog(changelog, '9.9.9')).toBe('');
    const file = { target: 'firefox', arch: 'any', kind: 'xpi', key: 'time-track-clients/firefox/0.1.0/a.xpi', sha256: 'x' };
    const stable = buildStable({ version: '0.1.0', notes: 'n', pubDate: new Date('2026-11-02T10:00:00.123Z'), minSupportedVersion: '0.1.0', files: [file] });
    expect(stable).toEqual({ version: '0.1.0', pub_date: '2026-11-02T10:00:00Z', notes: 'n', min_supported_version: '0.1.0', files: [file] });
    expect(Object.keys(stable).at(-1)).toBe('files');
    expect(buildStable({ version: '0.1.0', files: [file] })).not.toHaveProperty('min_supported_version');
    expect(() => buildStable({ version: '0.1.0', files: [] })).toThrow(/at least one/);
    expect(() => buildStable({ version: '0.1.0', minSupportedVersion: '9.9.9', files: [file] })).toThrow(/above the published version/);
    expect(() => buildStable({ version: '0.1.0', minSupportedVersion: 'x', files: [file] })).toThrow(/Invalid version/);
    expect(buildStable({ version: '0.1.0-rc.1', minSupportedVersion: '0.0.9', files: [{ ...file, key: 'time-track-clients/firefox/0.1.0-rc.1/a.xpi' }] }).min_supported_version).toBe('0.0.9');
    expect([compareVersions('1.0.0-a', '1.0.0'), compareVersions('1.0.0', '1.0.0-a'), compareVersions('1.0.0-b', '1.0.0-a'), compareVersions('1.0.0-a', '1.0.0-b'), compareVersions('1.2.3', '1.2.3')]).toEqual([-1, 1, 1, -1, 0]);
    expect(() => buildStable({ version: '0.2.0', files: [file] })).toThrow(/does not belong/);
    expect(() => buildStable({ version: '0.1.0', files: [file, file] })).toThrow(/Duplicate/);
    expect(parseFragments(`${JSON.stringify(file)}\n\n`)).toEqual([file]);
  });
});
