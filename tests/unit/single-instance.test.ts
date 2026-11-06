import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every TypeScript source file of the webview. */
function sources(dir = 'src'): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('one TimeTrack, one tray icon (0.5.1)', () => {
  it('the webview never creates a tray icon and has no tray permission', () => {
    for (const file of sources()) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/@tauri-apps\/api\/tray|TrayIcon\.new/);
    }
    for (const capability of ['default', 'prompt']) {
      const permissions: unknown[] = JSON.parse(readFileSync(`src-tauri/capabilities/${capability}.json`, 'utf8')).permissions;
      const names = permissions.filter((p): p is string => typeof p === 'string');
      // core:default includes core:tray:default (allow-new).
      expect(names, capability).not.toContain('core:default');
      expect(names.filter((p) => p.startsWith('core:tray')), capability).toEqual([]);
    }
  });

  it('the single-instance plugin is a dependency and keyed on the unchanged identifier', () => {
    expect(readFileSync('src-tauri/Cargo.toml', 'utf8')).toMatch(/^tauri-plugin-single-instance = "2"$/m);
    // The mutex / D-Bus name / socket derive from the identifier: changing it lets an old and a new copy run together.
    expect(JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).identifier).toBe('tech.nowo.timetrack');
  });

  it('the installer moves start at login to this install and drops a per-machine entry', () => {
    const hooks = readFileSync('src-tauri/windows/installer-hooks.nsh', 'utf8');
    const postinstall = hooks.slice(hooks.indexOf('!macro NSIS_HOOK_POSTINSTALL'));
    expect(postinstall).toContain('WriteRegStr HKCU "${TT_RUN_KEY}" "${TT_PRODUCT}" "$R9"');
    // 0.5.0 only moved it when the 0.1.0 copy was gone; both copies then started at login.
    expect(postinstall).not.toMatch(/AndIfNot\} \$\{FileExists\} "\$PROGRAMFILES64/);
    expect(postinstall).toContain('DeleteRegValue HKLM "${TT_RUN_KEY}" "${TT_PRODUCT}"');
    // Both rules only for the app's own executable in one of its install folders (never another "TimeTrack").
    expect(postinstall.match(/!insertmacro TT_OUR_COMMAND \$R8 \$R9\n {2}\$\{If\} \$R9 != ""/g)).toHaveLength(2);
    const macro = hooks.slice(hooks.indexOf('!macro TT_OUR_COMMAND'), hooks.indexOf('!macro NSIS_HOOK_POSTINSTALL'));
    for (const dir of ['$PROGRAMFILES64\\${TT_PRODUCT}', '$LOCALAPPDATA\\${TT_PRODUCT}', '$INSTDIR']) {
      for (const exe of ['time-track-desktop.exe', 'timetrack.exe']) {
        expect(macro).toContain(`!insertmacro TT_STARTS_WITH "\${CMD}" "${dir}\\${exe}"`);
      }
    }
    // Anchored at the start of the command (quoted or not), not a substring anywhere.
    const startsWith = hooks.slice(hooks.indexOf('!macro TT_STARTS_WITH'), hooks.indexOf('!macro TT_OUR_COMMAND'));
    expect(startsWith).not.toContain('StrLoc');
    expect(startsWith).toContain('StrLen $R5 "${PATH}"');
    // …and the path ends there: end of the command or a space (unquoted), the closing quote (quoted).
    expect(startsWith).toContain('StrCpy $R6 "${CMD}" 1 $R5');
    expect(startsWith).toMatch(/\$\{If\} \$R6 == ""\n\s+\$\{OrIf\} \$R6 == " "/);
    expect(startsWith).toContain('StrCpy $R6 "${CMD}" 1 $R4');
    // The rewritten value is quoted.
    expect(postinstall).toContain(`StrCpy $R9 '"$INSTDIR\\\${MAINBINARYNAME}.exe" --hidden'`);
  });

  it('Settings switches start at login through the app command, never the plugin enable / disable', () => {
    const main: unknown[] = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8')).permissions;
    expect(main).toContain('allow-set-autostart');
    expect(main).not.toContain('autostart:allow-enable');
    expect(main).not.toContain('autostart:allow-disable');
    // The state comes from the app too (only its own HKCU value on Windows), not the plugin's is_enabled.
    expect(main).toContain('allow-get-autostart');
    expect(main.filter((p) => typeof p === 'string' && p.startsWith('autostart:'))).toEqual([]);
    const bridge = readFileSync('src/platform-tauri.ts', 'utf8');
    expect(bridge).toContain("invoke('set_autostart', { enabled })");
    expect(bridge).toContain("invoke<boolean>('get_autostart')");
    expect(bridge).not.toContain('@tauri-apps/plugin-autostart');
    expect(bridge).not.toMatch(/import \{[^}]*\b(enable|disable)\b[^}]*\} from '@tauri-apps\/plugin-autostart'/);
  });
});
