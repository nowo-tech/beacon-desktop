//! Start-at-login housekeeping on Windows: at most one entry starts TimeTrack, and it starts the installed executable.
//!
//! The autostart plugin writes one value under `…\CurrentVersion\Run`, named after the product (`TimeTrack`), with
//! the executable path at the time it was switched on. Entries pointing at another copy pile up over the app's
//! history: the 0.1.0 `.msi` installed for all users in `C:\Program Files\TimeTrack`, 0.4.0+ installs per user in
//! `%LOCALAPPDATA%\TimeTrack`, and the plugin's "dynamic" mode writes to HKLM when the app runs elevated (e.g.
//! started from an installer). Two entries, two processes at login, two tray icons.
//!
//! At start-up (release builds, direct-download channel only), when the running executable is an installed copy
//! (directly in one of the install folders; a copy in Downloads, a portable or a dev build never takes over the login
//! entry), the app keeps start-at-login as a single HKCU value for that executable, with its path quoted, and removes
//! the app's other entries (HKLM ones only when it may; otherwise they are logged). Only the app's own entries are
//! touched: value name `TimeTrack` or `time-track-desktop`, executable `TimeTrack.exe` or `time-track-desktop.exe`,
//! in an install folder. Task Manager's "Disabled" (`StartupApproved\Run`) is kept: if any of the app's entries was
//! disabled, the remaining one is disabled too. Start-at-login is never switched on when none of the app's entries
//! existed.
//!
//! `plan` is pure and tested on every OS; `apply` (Windows) reads and writes the registry.
#![cfg_attr(not(windows), allow(dead_code))]

/// Executable names TimeTrack has shipped with (Tauri's main binary, and the product name some installers use).
const EXE_NAMES: [&str; 2] = ["timetrack.exe", "time-track-desktop.exe"];
/// Run value names the app (the autostart plugin, older builds) has used.
const VALUE_NAMES: [&str; 2] = ["timetrack", "time-track-desktop"];
/// Install folder name under `%LOCALAPPDATA%` (per-user NSIS) and Program Files (0.1.0 MSI).
pub const INSTALL_DIR: &str = "TimeTrack";

/// Where a Run value lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hive {
    CurrentUser,
    LocalMachine,
}

/// One value of a `Run` key, with its Task Manager state (`StartupApproved\Run` of the same hive), if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunEntry {
    pub hive: Hive,
    pub name: String,
    pub command: String,
    pub approved: Option<Vec<u8>>,
}

impl RunEntry {
    fn disabled(&self) -> bool {
        self.approved.as_deref().is_some_and(marker_disabled)
    }
}

/// What to change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fix {
    /// Remove this value and its Task Manager state (another copy, another name, or HKLM).
    Delete { hive: Hive, name: String },
    /// Write the app's own HKCU value for the installed executable.
    Write { name: String, command: String },
    /// Mark the app's HKCU value disabled in Task Manager (copied from the entry the user disabled).
    Disable { name: String, marker: Vec<u8> },
}

/// Whether a `StartupApproved\Run` value means "Disabled" (Task Manager stores the time it was disabled in the last
/// eight bytes; zeros mean enabled; the same rule as the autostart plugin's `is_enabled`).
pub fn marker_disabled(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && bytes.iter().rev().take(8).any(|b| *b != 0)
}

/// The executable of a Run command: a quoted path, else everything up to the first `.exe` (unquoted paths with
/// spaces, as the plugin writes them), else the first word.
pub fn command_exe(command: &str) -> &str {
    let command = command.trim();
    if let Some(rest) = command.strip_prefix('"') {
        return rest.split('"').next().unwrap_or(rest);
    }
    let lower = command.to_ascii_lowercase();
    if let Some(end) = lower.find(".exe") {
        return &command[..end + 4];
    }
    command.split_whitespace().next().unwrap_or(command)
}

fn file_name(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

fn norm(path: &str) -> String {
    path.trim().replace('/', "\\").to_lowercase()
}

/// Whether `path` is a file directly inside one of the install folders.
pub fn installed(path: &str, install_dirs: &[String]) -> bool {
    let path = norm(path);
    install_dirs.iter().any(|dir| {
        let dir = norm(dir);
        path.strip_prefix(dir.trim_end_matches('\\'))
            .and_then(|rest| rest.strip_prefix('\\'))
            .is_some_and(|rest| !rest.is_empty() && !rest.contains('\\'))
    })
}

/// Whether a Run value is one of the app's own: its value name, one of its executable names, in an install folder.
/// Anything else (another product called "TimeTrack", a copy elsewhere) is left alone.
pub fn is_ours(entry: &RunEntry, install_dirs: &[String]) -> bool {
    let exe = command_exe(&entry.command);
    VALUE_NAMES.contains(&entry.name.to_lowercase().as_str())
        && EXE_NAMES.contains(&file_name(exe).to_lowercase().as_str())
        && installed(exe, install_dirs)
}

/// The command written for `exe`: path quoted (no unquoted-path search at login), then the arguments.
pub fn command_for(exe: &str, args: &[&str]) -> String {
    let mut command = format!("\"{exe}\"");
    for arg in args {
        command.push(' ');
        command.push_str(arg);
    }
    command
}

/// The changes that leave one HKCU value `app_name` for `current_exe`, if any of the app's entries existed and the
/// running executable is an installed copy.
pub fn plan(
    entries: &[RunEntry],
    app_name: &str,
    current_exe: &str,
    install_dirs: &[String],
    args: &[&str],
) -> Vec<Fix> {
    if !installed(current_exe, install_dirs) {
        return Vec::new();
    }
    let own_value =
        |e: &RunEntry| e.hive == Hive::CurrentUser && e.name.eq_ignore_ascii_case(app_name);
    // Another product's HKCU value with the app's name: never overwritten, so nothing is consolidated.
    if entries
        .iter()
        .any(|e| own_value(e) && !is_ours(e, install_dirs))
    {
        return Vec::new();
    }
    let ours: Vec<&RunEntry> = entries
        .iter()
        .filter(|e| is_ours(e, install_dirs))
        .collect();
    if ours.is_empty() {
        return Vec::new();
    }
    let command = command_for(current_exe, args);
    let mut fixes: Vec<Fix> = ours
        .iter()
        // The HKCU value with the app's name is rewritten below, not deleted (its Task Manager state stays).
        .filter(|e| !own_value(e))
        .map(|e| Fix::Delete {
            hive: e.hive,
            name: e.name.clone(),
        })
        .collect();
    let own = ours.iter().find(|e| own_value(e));
    if !own.is_some_and(|e| e.command.trim().eq_ignore_ascii_case(&command)) {
        fixes.push(Fix::Write {
            name: app_name.to_string(),
            command,
        });
    }
    // Disabled anywhere: disabled after the clean-up too.
    if !own.is_some_and(|e| e.disabled()) {
        if let Some(marker) = ours
            .iter()
            .filter(|e| e.disabled())
            .find_map(|e| e.approved.clone())
        {
            fixes.push(Fix::Disable {
                name: app_name.to_string(),
                marker,
            });
        }
    }
    fixes
}

/// Reads the Run keys, applies `plan` and logs what changed. Never fails the start-up.
#[cfg(windows)]
pub fn apply(app_name: &str, args: &[&str]) {
    use winreg::enums::{
        HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, REG_BINARY,
    };
    use winreg::types::FromRegValue;
    use winreg::{RegKey, RegValue};

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let exe = exe.display().to_string();
    let install_dirs: Vec<String> = ["LOCALAPPDATA", "ProgramFiles", "ProgramW6432"]
        .iter()
        .filter_map(|var| std::env::var(var).ok())
        .map(|base| format!("{base}\\{INSTALL_DIR}"))
        .collect();
    let root = |hive: Hive| {
        RegKey::predef(match hive {
            Hive::CurrentUser => HKEY_CURRENT_USER,
            Hive::LocalMachine => HKEY_LOCAL_MACHINE,
        })
    };
    let mut entries = Vec::new();
    for hive in [Hive::CurrentUser, Hive::LocalMachine] {
        let approved = root(hive).open_subkey_with_flags(APPROVED, KEY_READ).ok();
        if let Ok(key) = root(hive).open_subkey_with_flags(RUN, KEY_READ) {
            for (name, value) in key.enum_values().flatten() {
                if let Ok(command) = String::from_reg_value(&value) {
                    let approved = approved
                        .as_ref()
                        .and_then(|k| k.get_raw_value(&name).ok())
                        .map(|v| v.bytes.to_vec());
                    entries.push(RunEntry {
                        hive,
                        name,
                        command,
                        approved,
                    });
                }
            }
        }
    }
    for fix in plan(&entries, app_name, &exe, &install_dirs, args) {
        let result = match &fix {
            Fix::Delete { hive, name } => root(*hive)
                .open_subkey_with_flags(RUN, KEY_SET_VALUE)
                .and_then(|key| key.delete_value(name))
                .map(|()| {
                    if let Ok(key) = root(*hive).open_subkey_with_flags(APPROVED, KEY_SET_VALUE) {
                        let _ = key.delete_value(name);
                    }
                }),
            Fix::Write { name, command } => root(Hive::CurrentUser)
                .create_subkey(RUN)
                .and_then(|(key, _)| key.set_value(name, command)),
            Fix::Disable { name, marker } => root(Hive::CurrentUser)
                .create_subkey(APPROVED)
                .and_then(|(key, _)| {
                    key.set_raw_value(
                        name,
                        &RegValue {
                            bytes: marker.clone().into(),
                            vtype: REG_BINARY,
                        },
                    )
                }),
        };
        match result {
            Ok(()) => eprintln!("autostart: {fix:?}"),
            Err(error) => eprintln!("autostart: {fix:?} failed: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const APP: &str = "TimeTrack";
    const ARGS: [&str; 1] = ["--hidden"];
    const NEW: &str = r"C:\Users\ana\AppData\Local\TimeTrack\time-track-desktop.exe";
    const MSI: &str = r"C:\Program Files\TimeTrack\time-track-desktop.exe";
    const ENABLED: [u8; 12] = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const DISABLED: [u8; 12] = [3, 0, 0, 0, 0x10, 0x8e, 0x3c, 0x51, 0x2a, 0x4e, 0xdb, 0x01];

    fn dirs() -> Vec<String> {
        vec![
            r"C:\Users\ana\AppData\Local\TimeTrack".into(),
            r"C:\Program Files\TimeTrack".into(),
        ]
    }

    fn entry(hive: Hive, name: &str, command: &str) -> RunEntry {
        RunEntry {
            hive,
            name: name.into(),
            command: command.into(),
            approved: None,
        }
    }

    fn with(mut e: RunEntry, marker: &[u8]) -> RunEntry {
        e.approved = Some(marker.to_vec());
        e
    }

    fn run_as(exe: &str, entries: &[RunEntry]) -> Vec<Fix> {
        plan(entries, APP, exe, &dirs(), &ARGS)
    }

    fn run(entries: &[RunEntry]) -> Vec<Fix> {
        run_as(NEW, entries)
    }

    fn delete(hive: Hive, name: &str) -> Fix {
        Fix::Delete {
            hive,
            name: name.into(),
        }
    }

    fn write(exe: &str) -> Fix {
        Fix::Write {
            name: APP.into(),
            command: format!("\"{exe}\" --hidden"),
        }
    }

    fn disable() -> Fix {
        Fix::Disable {
            name: APP.into(),
            marker: DISABLED.to_vec(),
        }
    }

    #[test]
    fn reads_the_executable_of_a_run_command() {
        assert_eq!(command_exe(&format!("{MSI} --hidden")), MSI);
        assert_eq!(command_exe(&format!("\"{MSI}\" --hidden")), MSI);
        assert_eq!(
            command_exe(r"C:\Tools\TimeTrack.EXE"),
            r"C:\Tools\TimeTrack.EXE"
        );
        assert_eq!(command_exe("  other --flag"), "other");
        assert_eq!(command_exe(""), "");
    }

    #[test]
    fn writes_the_path_quoted() {
        assert_eq!(command_for(MSI, &ARGS), format!("\"{MSI}\" --hidden"));
        assert_eq!(command_for(MSI, &[]), format!("\"{MSI}\""));
        assert_eq!(command_exe(&command_for(MSI, &ARGS)), MSI);
    }

    #[test]
    fn knows_the_install_folders() {
        assert!(installed(NEW, &dirs()));
        assert!(installed(&MSI.to_uppercase().replace('\\', "/"), &dirs()));
        assert!(installed(MSI, &[r"C:\Program Files\TimeTrack\".into()]));
        for elsewhere in [
            r"C:\Users\ana\Downloads\time-track-desktop.exe",
            r"C:\Users\ana\AppData\Local\TimeTrackOld\time-track-desktop.exe",
            r"C:\Program Files\TimeTrack\sub\time-track-desktop.exe",
            r"C:\Program Files\TimeTrack\",
        ] {
            assert!(!installed(elsewhere, &dirs()), "{elsewhere}");
        }
    }

    #[test]
    fn nothing_to_do_without_entries_or_with_the_right_one() {
        assert!(run(&[]).is_empty());
        let others = [
            entry(
                Hive::CurrentUser,
                "OneDrive",
                r#""C:\OneDrive\OneDrive.exe" /background"#,
            ),
            entry(
                Hive::CurrentUser,
                "TimeTrackPro",
                r"C:\Apps\TimeTrack\ttpro.exe",
            ),
        ];
        assert!(run(&others).is_empty());
        let right = [entry(Hive::CurrentUser, APP, &command_for(NEW, &ARGS))];
        assert!(run(&right).is_empty());
        let upper = [entry(
            Hive::CurrentUser,
            APP,
            &command_for(NEW, &ARGS).to_uppercase(),
        )];
        assert!(run(&upper).is_empty());
    }

    #[test]
    fn quotes_an_unquoted_value_for_this_copy() {
        let entries = [entry(Hive::CurrentUser, APP, &format!("{NEW} --hidden"))];
        assert_eq!(run(&entries), vec![write(NEW)]);
    }

    #[test]
    fn follows_the_app_from_the_msi_copy_to_this_one() {
        let entries = [entry(Hive::CurrentUser, APP, &format!("{MSI} --hidden"))];
        assert_eq!(run(&entries), vec![write(NEW)]);
    }

    #[test]
    fn a_copy_outside_the_install_folders_changes_nothing() {
        let entries = [
            entry(Hive::CurrentUser, APP, &format!("{MSI} --hidden")),
            entry(Hive::LocalMachine, APP, &format!("{MSI} --hidden")),
        ];
        for exe in [
            r"C:\Users\ana\Downloads\time-track-desktop.exe",
            r"D:\My Tools\TimeTrack\portable\TimeTrack.exe",
            r"D:\dev\time-track-desktop\src-tauri\target\release\time-track-desktop.exe",
        ] {
            assert!(run_as(exe, &entries).is_empty(), "{exe}");
        }
        // The MSI copy is an installed copy.
        assert_eq!(
            run_as(MSI, &entries),
            vec![delete(Hive::LocalMachine, APP), write(MSI)]
        );
    }

    #[test]
    fn removes_hklm_and_the_other_name_and_keeps_one_hkcu_value() {
        let fixes = run(&[
            entry(Hive::LocalMachine, APP, &format!("{MSI} --hidden")),
            entry(
                Hive::CurrentUser,
                "time-track-desktop",
                &format!("{NEW} --hidden"),
            ),
            entry(Hive::CurrentUser, APP, &command_for(NEW, &ARGS)),
            entry(
                Hive::CurrentUser,
                "Spotify",
                r"C:\Spotify\Spotify.exe /minimized",
            ),
        ]);
        assert_eq!(
            fixes,
            vec![
                delete(Hive::LocalMachine, APP),
                delete(Hive::CurrentUser, "time-track-desktop"),
            ]
        );
    }

    #[test]
    fn an_hklm_only_entry_moves_to_hkcu() {
        let fixes = run(&[entry(Hive::LocalMachine, APP, &format!("{NEW} --hidden"))]);
        assert_eq!(fixes, vec![delete(Hive::LocalMachine, APP), write(NEW)]);
    }

    #[test]
    fn a_disabled_entry_stays_disabled() {
        assert!(marker_disabled(&DISABLED));
        assert!(!marker_disabled(&ENABLED));
        assert!(!marker_disabled(&[3]));
        // Disabled under another name: the HKCU value is written and disabled too.
        let fixes = run(&[with(
            entry(
                Hive::CurrentUser,
                "time-track-desktop",
                &format!("{MSI} --hidden"),
            ),
            &DISABLED,
        )]);
        assert_eq!(
            fixes,
            vec![
                delete(Hive::CurrentUser, "time-track-desktop"),
                write(NEW),
                disable()
            ]
        );
        // Disabled in HKLM while the HKCU value is enabled: disabled.
        let fixes = run(&[
            with(
                entry(Hive::LocalMachine, APP, &format!("{MSI} --hidden")),
                &DISABLED,
            ),
            with(
                entry(Hive::CurrentUser, APP, &command_for(NEW, &ARGS)),
                &ENABLED,
            ),
        ]);
        assert_eq!(fixes, vec![delete(Hive::LocalMachine, APP), disable()]);
        // The HKCU value itself disabled: its own state stays (rewritten, not deleted), nothing to copy.
        let fixes = run(&[with(
            entry(Hive::CurrentUser, APP, &format!("{MSI} --hidden")),
            &DISABLED,
        )]);
        assert_eq!(fixes, vec![write(NEW)]);
        // Enabled markers are not copied.
        let fixes = run(&[with(
            entry(Hive::LocalMachine, APP, &format!("{NEW} --hidden")),
            &ENABLED,
        )]);
        assert_eq!(fixes, vec![delete(Hive::LocalMachine, APP), write(NEW)]);
    }

    #[test]
    fn never_touches_another_products_entries() {
        let foreign = [
            // Another vendor's "TimeTrack": same file and folder names, other value names.
            entry(
                Hive::CurrentUser,
                "TimeTrack Vendor",
                r"C:\Vendor\TimeTrack\TimeTrack.exe",
            ),
            entry(
                Hive::CurrentUser,
                "Agent",
                r#""C:\Program Files\TimeTrack\TimeTrack.exe" --tray"#,
            ),
            // Our value names, another executable or folder.
            entry(
                Hive::LocalMachine,
                APP,
                r"C:\Vendor\TimeTrack\TimeTrackAgent.exe --tray",
            ),
            entry(
                Hive::LocalMachine,
                "time-track-desktop",
                r"C:\Vendor\Other\time-track-desktop.exe",
            ),
        ];
        for e in &foreign {
            assert!(!is_ours(e, &dirs()), "{e:?}");
        }
        assert!(run(&foreign).is_empty());
        // Next to one of ours: only ours changes.
        let mut entries = foreign.to_vec();
        entries.push(entry(
            Hive::CurrentUser,
            "time-track-desktop",
            &format!("{MSI} --hidden"),
        ));
        assert_eq!(
            run(&entries),
            vec![delete(Hive::CurrentUser, "time-track-desktop"), write(NEW)]
        );
        // Another product holds the HKCU "TimeTrack" value: never overwritten, nothing consolidated.
        let taken = [
            entry(Hive::CurrentUser, APP, r"C:\Vendor\TimeTrack\TimeTrack.exe"),
            entry(
                Hive::CurrentUser,
                "time-track-desktop",
                &format!("{MSI} --hidden"),
            ),
        ];
        assert!(run(&taken).is_empty());
    }

    #[test]
    fn recognises_its_own_entries_only_in_the_install_folders() {
        let ours =
            |name: &str, command: &str| is_ours(&entry(Hive::CurrentUser, name, command), &dirs());
        assert!(ours(APP, &format!("{NEW} --hidden")));
        assert!(ours(
            "TIME-TRACK-DESKTOP",
            r#""C:\Program Files\TimeTrack\TimeTrack.exe""#
        ));
        assert!(!ours(APP, r"D:\dev\target\release\time-track-desktop.exe"));
        assert!(!ours("Old", &format!("{NEW} --hidden")));
    }
}
