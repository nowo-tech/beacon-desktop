//! Windows: the microphone "Recent activity" store (Settings → Privacy & security → Microphone), per user.
//!
//! `HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone` holds one subkey
//! per packaged app (its package family name, e.g. `MSTeams_8wekyb3d8bbwe`) and, under `NonPackaged`, one per
//! executable path with `\` written as `#` (`C:#Program Files#Zoom#bin#Zoom.exe`). Each has `LastUsedTimeStart` and
//! `LastUsedTimeStop` (FILETIME); while the app uses the microphone, `LastUsedTimeStop` is 0. Only those names and
//! the two numbers are read; the path is reduced to a known app id by `classify` before it leaves the module.

#[cfg_attr(not(windows), allow(dead_code))]
pub const MICROPHONE_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

/// One app's entry of the store.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsentEntry {
    /// Package family name, or the executable path with `#` for `\`.
    pub name: String,
    pub last_start: u64,
    pub last_stop: u64,
}

/// The apps using the microphone now: started at least once and not stopped since.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn holders(entries: &[ConsentEntry]) -> Vec<String> {
    entries
        .iter()
        .filter(|entry| entry.last_start != 0 && entry.last_stop == 0)
        .map(|entry| entry.name.clone())
        .collect()
}

#[cfg(windows)]
pub struct ConsentStore;

#[cfg(windows)]
impl super::MicDetector for ConsentStore {
    fn probe(&mut self) -> super::Probe {
        match read_store() {
            Ok(entries) => super::Probe::named(holders(&entries)),
            Err(_) => super::Probe::unavailable(),
        }
    }
}

#[cfg(windows)]
fn read_store() -> std::io::Result<Vec<ConsentEntry>> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let root =
        RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(MICROPHONE_KEY, KEY_READ)?;
    let entry = |name: String, key: &RegKey| ConsentEntry {
        last_start: key.get_value::<u64, _>("LastUsedTimeStart").unwrap_or(0),
        last_stop: key.get_value::<u64, _>("LastUsedTimeStop").unwrap_or(0),
        name,
    };
    let mut entries = Vec::new();
    for name in root.enum_keys().flatten() {
        let Ok(key) = root.open_subkey_with_flags(&name, KEY_READ) else {
            continue;
        };
        if name.eq_ignore_ascii_case("NonPackaged") {
            for path in key.enum_keys().flatten() {
                if let Ok(app) = key.open_subkey_with_flags(&path, KEY_READ) {
                    entries.push(entry(path, &app));
                }
            }
        } else {
            entries.push(entry(name, &key));
        }
    }
    Ok(entries)
}

/// Reads a `reg export` of the store (UTF-8): the fixture format of the tests, and what a user can send when the
/// detection misbehaves (`reg export HKCU\…\ConsentStore\microphone mic.reg`).
#[cfg(test)]
pub fn parse_reg_export(text: &str) -> Vec<ConsentEntry> {
    let mut entries: Vec<ConsentEntry> = Vec::new();
    let mut current: Option<ConsentEntry> = None;
    let flush = |current: &mut Option<ConsentEntry>, entries: &mut Vec<ConsentEntry>| {
        if let Some(entry) = current.take() {
            if entry.last_start != 0 || entry.last_stop != 0 {
                entries.push(entry);
            }
        }
    };
    for line in text.lines().map(str::trim) {
        if let Some(path) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            flush(&mut current, &mut entries);
            let lower = path.to_lowercase();
            let Some(at) = lower.find("\\microphone\\") else {
                continue;
            };
            let rest = &path[at + "\\microphone\\".len()..];
            let name = rest
                .strip_prefix("NonPackaged\\")
                .unwrap_or(rest)
                .to_string();
            current = Some(ConsentEntry {
                name,
                last_start: 0,
                last_stop: 0,
            });
        } else if let (Some(entry), Some((key, value))) = (current.as_mut(), line.split_once('=')) {
            let number = value
                .strip_prefix("hex(b):")
                .map(|hex| {
                    hex.split(',')
                        .filter_map(|byte| u8::from_str_radix(byte.trim(), 16).ok())
                        .enumerate()
                        .fold(0u64, |acc, (i, byte)| acc | (u64::from(byte) << (8 * i)))
                })
                .unwrap_or(0);
            match key.trim_matches('"') {
                "LastUsedTimeStart" => entry.last_start = number,
                "LastUsedTimeStop" => entry.last_stop = number,
                _ => {}
            }
        }
    }
    flush(&mut current, &mut entries);
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::{snapshot, MeetingApp, Probe};

    fn apps(fixture: &str) -> Vec<MeetingApp> {
        snapshot(Probe::named(holders(&parse_reg_export(fixture))), 0).apps
    }

    #[test]
    fn new_teams_in_a_call_is_found_by_its_package() {
        let fixture = include_str!("../../tests/fixtures/meeting/windows-teams-call.reg");
        let entries = parse_reg_export(fixture);
        // Packaged Teams and Windows Sound Recorder, plus Zoom and Chrome under NonPackaged.
        assert_eq!(entries.len(), 4);
        let teams = entries
            .iter()
            .find(|e| e.name == "MSTeams_8wekyb3d8bbwe")
            .unwrap();
        assert_eq!(teams.last_start, 0x01dc_4e1f_2b3c_4d5e);
        assert_eq!(teams.last_stop, 0);
        assert_eq!(holders(&entries), vec!["MSTeams_8wekyb3d8bbwe".to_string()]);
        assert_eq!(apps(fixture), vec![MeetingApp::Teams]);
    }

    #[test]
    fn a_zoom_call_and_a_browser_call_under_non_packaged() {
        let fixture = include_str!("../../tests/fixtures/meeting/windows-zoom-and-browser.reg");
        assert_eq!(
            holders(&parse_reg_export(fixture)),
            vec![
                "C:#Users#ana#AppData#Roaming#Zoom#bin#Zoom.exe".to_string(),
                "C:#Program Files#Google#Chrome#Application#chrome.exe".to_string()
            ]
        );
        assert_eq!(apps(fixture), vec![MeetingApp::Zoom, MeetingApp::Browser]);
    }

    #[test]
    fn nothing_in_use_after_the_call() {
        let fixture = include_str!("../../tests/fixtures/meeting/windows-idle.reg");
        assert!(!parse_reg_export(fixture).is_empty());
        let probe = Probe::named(holders(&parse_reg_export(fixture)));
        assert!(!probe.in_use);
        assert!(apps(fixture).is_empty());
    }

    #[test]
    fn an_unknown_recorder_counts_as_in_use_without_an_app() {
        let entries = vec![
            ConsentEntry {
                name: "Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe".into(),
                last_start: 5,
                last_stop: 0,
            },
            // Never used: no start.
            ConsentEntry {
                name: "MSTeams_8wekyb3d8bbwe".into(),
                last_start: 0,
                last_stop: 0,
            },
        ];
        let snap = snapshot(Probe::named(holders(&entries)), 0);
        assert!(snap.in_use);
        assert!(snap.apps.is_empty());
        assert!(MICROPHONE_KEY.ends_with(r"ConsentStore\microphone"));
    }
}
