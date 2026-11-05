//! Start-at-login housekeeping on Windows: at most one entry starts TimeTrack, and it starts this executable.
//!
//! The autostart plugin writes one value under `…\CurrentVersion\Run`, named after the product (`TimeTrack`), with
//! the executable path at the time it was switched on. Entries pointing at another copy pile up over the app's
//! history: the 0.1.0 `.msi` installed for all users in `C:\Program Files\TimeTrack`, 0.4.0+ installs per user in
//! `%LOCALAPPDATA%\TimeTrack`, and the plugin's "dynamic" mode writes to HKLM when the app runs elevated (e.g.
//! started from an installer). Two entries, two processes at login, two tray icons. At start-up (release builds,
//! direct-download channel only) the app keeps start-at-login on if any of its entries existed, as a single HKCU
//! value for the running executable, and removes the others (HKLM ones only when it may; otherwise they are logged).
//!
//! `plan` is pure and tested on every OS; `apply` (Windows) reads and writes the registry.
#![cfg_attr(not(windows), allow(dead_code))]

/// Executable names TimeTrack has shipped with (Tauri's main binary, and the product name some installers use).
const EXE_NAMES: [&str; 2] = ["timetrack.exe", "time-track-desktop.exe"];
/// Install folder of every Windows installer so far (per user in `%LOCALAPPDATA%`, per machine in Program Files).
const INSTALL_DIR: &str = "timetrack";

/// Where a Run value lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hive {
    CurrentUser,
    LocalMachine,
}

/// One value of a `Run` key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunEntry {
    pub hive: Hive,
    pub name: String,
    pub command: String,
}

/// What to change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fix {
    /// Remove this value (another copy, another name, or HKLM).
    Delete { hive: Hive, name: String },
    /// Write the app's own HKCU value: start-at-login was on, for another executable.
    Write { name: String, command: String },
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

fn parent_name(path: &str) -> &str {
    let mut parts = path.rsplit(['\\', '/']);
    parts.next();
    parts.next().unwrap_or("")
}

fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| p.trim().replace('/', "\\").to_lowercase();
    norm(a) == norm(b)
}

/// Whether a Run value starts some copy of TimeTrack: one of its executable names, under the app's value name or in
/// a `TimeTrack` folder. Another product's `TimeTrack` value (another executable) is left alone.
pub fn is_ours(entry: &RunEntry, app_name: &str) -> bool {
    let exe = command_exe(&entry.command);
    let named = EXE_NAMES.contains(&file_name(exe).to_lowercase().as_str());
    named
        && (entry.name.eq_ignore_ascii_case(app_name)
            || parent_name(exe).eq_ignore_ascii_case(INSTALL_DIR))
}

/// The command the autostart plugin writes for `exe` (same format, so its own enable / disable keep working).
pub fn command_for(exe: &str, args: &[&str]) -> String {
    format!("{} {}", exe, args.join(" "))
}

/// The changes that leave one HKCU value `app_name` for `current_exe`, if any of the app's entries existed.
pub fn plan(entries: &[RunEntry], app_name: &str, current_exe: &str, args: &[&str]) -> Vec<Fix> {
    let ours: Vec<&RunEntry> = entries.iter().filter(|e| is_ours(e, app_name)).collect();
    if ours.is_empty() {
        return Vec::new();
    }
    let keep = |e: &RunEntry| {
        e.hive == Hive::CurrentUser
            && e.name.eq_ignore_ascii_case(app_name)
            && same_path(command_exe(&e.command), current_exe)
    };
    let mut fixes: Vec<Fix> = ours
        .iter()
        .filter(|e| !keep(e))
        // The HKCU value with the app's name is rewritten below, not deleted (its Task Manager state stays).
        .filter(|e| !(e.hive == Hive::CurrentUser && e.name.eq_ignore_ascii_case(app_name)))
        .map(|e| Fix::Delete {
            hive: e.hive,
            name: e.name.clone(),
        })
        .collect();
    if !ours.iter().any(|e| keep(e)) {
        fixes.push(Fix::Write {
            name: app_name.to_string(),
            command: command_for(current_exe, args),
        });
    }
    fixes
}

/// Reads the Run keys, applies `plan` and logs what changed. Never fails the start-up.
#[cfg(windows)]
pub fn apply(app_name: &str, args: &[&str]) {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE};
    use winreg::types::FromRegValue;
    use winreg::RegKey;

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let exe = exe.display().to_string();
    let root = |hive: Hive| {
        RegKey::predef(match hive {
            Hive::CurrentUser => HKEY_CURRENT_USER,
            Hive::LocalMachine => HKEY_LOCAL_MACHINE,
        })
    };
    let mut entries = Vec::new();
    for hive in [Hive::CurrentUser, Hive::LocalMachine] {
        if let Ok(key) = root(hive).open_subkey_with_flags(RUN, KEY_READ) {
            for (name, value) in key.enum_values().flatten() {
                if let Ok(command) = String::from_reg_value(&value) {
                    entries.push(RunEntry {
                        hive,
                        name,
                        command,
                    });
                }
            }
        }
    }
    for fix in plan(&entries, app_name, &exe, args) {
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

    fn entry(hive: Hive, name: &str, command: &str) -> RunEntry {
        RunEntry {
            hive,
            name: name.into(),
            command: command.into(),
        }
    }

    fn run(entries: &[RunEntry]) -> Vec<Fix> {
        plan(entries, APP, NEW, &ARGS)
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
    fn nothing_to_do_without_entries_or_with_the_right_one() {
        assert!(run(&[]).is_empty());
        let others = [
            entry(
                Hive::CurrentUser,
                "OneDrive",
                r#""C:\OneDrive\OneDrive.exe" /background"#,
            ),
            // Another product named TimeTrack: another executable, left alone.
            entry(
                Hive::CurrentUser,
                "TimeTrackPro",
                r"C:\Apps\TimeTrack\ttpro.exe",
            ),
        ];
        assert!(run(&others).is_empty());
        let right = [entry(Hive::CurrentUser, APP, &command_for(NEW, &ARGS))];
        assert!(run(&right).is_empty());
        // Path case and slashes do not matter.
        let upper = [entry(
            Hive::CurrentUser,
            APP,
            &NEW.to_uppercase().replace('\\', "/"),
        )];
        assert!(run(&upper).is_empty());
    }

    #[test]
    fn follows_the_app_from_the_msi_copy_to_this_one() {
        let fixes = run(&[entry(Hive::CurrentUser, APP, &format!("{MSI} --hidden"))]);
        assert_eq!(
            fixes,
            vec![Fix::Write {
                name: APP.into(),
                command: format!("{NEW} --hidden")
            }]
        );
    }

    #[test]
    fn removes_hklm_and_other_names_and_keeps_one_hkcu_value() {
        let fixes = run(&[
            entry(Hive::LocalMachine, APP, &format!("{MSI} --hidden")),
            entry(
                Hive::CurrentUser,
                "time-track-desktop",
                &format!("{NEW} --hidden"),
            ),
            entry(Hive::CurrentUser, APP, &format!("{NEW} --hidden")),
            entry(
                Hive::CurrentUser,
                "Spotify",
                r"C:\Spotify\Spotify.exe /minimized",
            ),
        ]);
        assert_eq!(
            fixes,
            vec![
                Fix::Delete {
                    hive: Hive::LocalMachine,
                    name: APP.into()
                },
                Fix::Delete {
                    hive: Hive::CurrentUser,
                    name: "time-track-desktop".into()
                },
            ]
        );
    }

    #[test]
    fn an_hklm_only_entry_moves_to_hkcu() {
        let fixes = run(&[entry(Hive::LocalMachine, APP, &format!("{NEW} --hidden"))]);
        assert_eq!(
            fixes,
            vec![
                Fix::Delete {
                    hive: Hive::LocalMachine,
                    name: APP.into()
                },
                Fix::Write {
                    name: APP.into(),
                    command: format!("{NEW} --hidden")
                },
            ]
        );
    }

    #[test]
    fn recognises_copies_by_name_or_install_folder() {
        assert!(is_ours(
            &entry(
                Hive::CurrentUser,
                APP,
                r"D:\dev\target\release\time-track-desktop.exe"
            ),
            APP
        ));
        assert!(is_ours(
            &entry(
                Hive::CurrentUser,
                "Old",
                r#""C:\Program Files\TimeTrack\TimeTrack.exe""#
            ),
            APP
        ));
        assert!(!is_ours(
            &entry(
                Hive::CurrentUser,
                "Old",
                r"D:\dev\target\release\time-track-desktop.exe"
            ),
            APP
        ));
        assert!(!is_ours(
            &entry(Hive::CurrentUser, APP, r"C:\Other\other.exe"),
            APP
        ));
    }
}
