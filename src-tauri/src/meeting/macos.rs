//! macOS: CoreAudio.
//!
//! - `kAudioDevicePropertyDeviceIsRunningSomewhere` of the default input device: some process records from it.
//! - macOS 14+: `kAudioHardwarePropertyProcessObjectList`, one audio object per process that uses audio, with
//!   `kAudioProcessPropertyIsRunningInput` (it records now) and `kAudioProcessPropertyBundleID` (or its PID, whose
//!   executable name is used when there is no bundle id).
//! - Before macOS 14 (no process objects), or when they say nothing: while the input runs, the known meeting apps
//!   among the running processes ([`super::likely_holders`]); the source is then `fallback`.
//!
//! Reading these properties needs no microphone permission and opens no audio stream.

/// One CoreAudio process object, as read (or as written in a fixture).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioProcess {
    /// Bundle id, else the executable name.
    pub identity: String,
    /// `kAudioProcessPropertyIsRunningInput`.
    pub running_input: bool,
}

/// The processes recording now.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn recording(processes: &[AudioProcess]) -> Vec<String> {
    processes
        .iter()
        .filter(|process| process.running_input && !process.identity.is_empty())
        .map(|process| process.identity.clone())
        .collect()
}

/// What CoreAudio answered, turned into a probe: the recording processes when the system lists them, else the known
/// meeting apps running while the input device is in use.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn decide(
    input_running: Option<bool>,
    processes: Option<&[AudioProcess]>,
    running_apps: impl FnOnce() -> Vec<String>,
) -> super::Probe {
    let Some(input_running) = input_running else {
        return super::Probe::unavailable();
    };
    if let Some(list) = processes {
        let holders = recording(list);
        if !holders.is_empty() || !input_running {
            return super::Probe {
                in_use: input_running || !holders.is_empty(),
                holders,
                source: super::Source::Process,
            };
        }
    }
    if !input_running {
        return super::Probe {
            in_use: false,
            holders: Vec::new(),
            source: super::Source::Fallback,
        };
    }
    super::Probe {
        in_use: true,
        holders: super::likely_holders(&running_apps()),
        source: super::Source::Fallback,
    }
}

/// Reads a dump of the process objects (`<pid>\t<bundle id or name>\t<running input 0/1>` per line, `#` comments,
/// first line `input-running: yes|no|unknown`, then `processes: none` on systems without the list) — the fixture
/// format of the tests.
#[cfg(test)]
pub fn parse_dump(text: &str) -> (Option<bool>, Option<Vec<AudioProcess>>) {
    let mut input = None;
    let mut processes = Some(Vec::new());
    for line in text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
    {
        if let Some(value) = line.strip_prefix("input-running:") {
            input = match value.trim() {
                "yes" => Some(true),
                "no" => Some(false),
                _ => None,
            };
        } else if line == "processes: none" {
            processes = None;
        } else if let Some(list) = processes.as_mut() {
            let fields: Vec<&str> = line.split('\t').collect();
            if fields.len() == 3 {
                list.push(AudioProcess {
                    identity: fields[1].to_string(),
                    running_input: fields[2] == "1",
                });
            }
        }
    }
    (input, processes)
}

#[cfg(target_os = "macos")]
pub struct CoreAudio;

#[cfg(target_os = "macos")]
impl super::MicDetector for CoreAudio {
    fn probe(&mut self) -> super::Probe {
        let device = ffi::default_input();
        let input_running = device.and_then(ffi::running_somewhere);
        let processes = ffi::processes();
        decide(input_running, processes.as_deref(), ffi::running_apps)
    }
}

#[cfg(target_os = "macos")]
mod ffi {
    use super::AudioProcess;
    use core_foundation_sys::base::{CFRelease, CFTypeRef};
    use core_foundation_sys::string::{kCFStringEncodingUTF8, CFStringGetCString, CFStringRef};
    use std::ffi::{c_void, CStr};

    type ObjectId = u32;
    type OsStatus = i32;

    #[repr(C)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyDataSize(
            object: ObjectId,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
        ) -> OsStatus;
        fn AudioObjectGetPropertyData(
            object: ObjectId,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
            data: *mut c_void,
        ) -> OsStatus;
    }

    const fn code(name: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*name)
    }

    const SYSTEM_OBJECT: ObjectId = 1;
    const SCOPE_GLOBAL: u32 = code(b"glob");
    const ELEMENT_MAIN: u32 = 0;
    const DEFAULT_INPUT_DEVICE: u32 = code(b"dIn ");
    const IS_RUNNING_SOMEWHERE: u32 = code(b"gone");
    const PROCESS_OBJECT_LIST: u32 = code(b"prs#");
    const PROCESS_PID: u32 = code(b"ppid");
    const PROCESS_BUNDLE_ID: u32 = code(b"pbid");
    const PROCESS_IS_RUNNING_INPUT: u32 = code(b"piri");

    fn address(selector: u32) -> Address {
        Address {
            selector,
            scope: SCOPE_GLOBAL,
            element: ELEMENT_MAIN,
        }
    }

    /// A fixed-size property (`u32`, `i32`, a CF reference).
    fn read<T: Copy + Default>(object: ObjectId, selector: u32) -> Option<T> {
        let mut value = T::default();
        let mut size = std::mem::size_of::<T>() as u32;
        // SAFETY: `value` is a valid, writable `T` of `size` bytes; CoreAudio writes at most `size` bytes.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &address(selector),
                0,
                std::ptr::null(),
                &mut size,
                (&mut value as *mut T).cast(),
            )
        };
        (status == 0 && size as usize == std::mem::size_of::<T>()).then_some(value)
    }

    pub fn default_input() -> Option<ObjectId> {
        read::<u32>(SYSTEM_OBJECT, DEFAULT_INPUT_DEVICE).filter(|id| *id != 0)
    }

    pub fn running_somewhere(device: ObjectId) -> Option<bool> {
        read::<u32>(device, IS_RUNNING_SOMEWHERE).map(|value| value != 0)
    }

    /// The process objects with their identity and input flag; `None` before macOS 14 (unknown property).
    pub fn processes() -> Option<Vec<AudioProcess>> {
        let property = address(PROCESS_OBJECT_LIST);
        let mut size = 0u32;
        // SAFETY: only writes the size of the property into `size`.
        let status = unsafe {
            AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, &property, 0, std::ptr::null(), &mut size)
        };
        if status != 0 {
            return None;
        }
        let mut ids = vec![0 as ObjectId; size as usize / std::mem::size_of::<ObjectId>()];
        let mut bytes = (ids.len() * std::mem::size_of::<ObjectId>()) as u32;
        // SAFETY: `ids` has room for `bytes` bytes; CoreAudio writes at most that many and updates `bytes`.
        let status = unsafe {
            AudioObjectGetPropertyData(
                SYSTEM_OBJECT,
                &property,
                0,
                std::ptr::null(),
                &mut bytes,
                ids.as_mut_ptr().cast(),
            )
        };
        if status != 0 {
            return None;
        }
        ids.truncate(bytes as usize / std::mem::size_of::<ObjectId>());
        Some(
            ids.into_iter()
                .map(|id| AudioProcess {
                    running_input: read::<u32>(id, PROCESS_IS_RUNNING_INPUT).unwrap_or(0) != 0,
                    identity: bundle_id(id)
                        .or_else(|| read::<i32>(id, PROCESS_PID).and_then(executable_name))
                        .unwrap_or_default(),
                })
                .collect(),
        )
    }

    fn bundle_id(object: ObjectId) -> Option<String> {
        let reference =
            read::<usize>(object, PROCESS_BUNDLE_ID).filter(|r| *r != 0)? as CFStringRef;
        let mut buffer = [0 as std::ffi::c_char; 256];
        // SAFETY: `reference` is the CFString CoreAudio returned (owned by us: released below); the buffer is sized.
        let ok = unsafe {
            let ok = CFStringGetCString(
                reference,
                buffer.as_mut_ptr(),
                buffer.len() as _,
                kCFStringEncodingUTF8,
            );
            CFRelease(reference as CFTypeRef);
            ok
        };
        if ok == 0 {
            return None;
        }
        // SAFETY: CFStringGetCString wrote a NUL-terminated string into `buffer`.
        let text = unsafe { CStr::from_ptr(buffer.as_ptr()) }
            .to_string_lossy()
            .to_string();
        (!text.is_empty()).then_some(text)
    }

    /// The executable's file name of `pid` (no arguments, no window).
    fn executable_name(pid: i32) -> Option<String> {
        let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: the buffer has the size passed.
        let length =
            unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        if length <= 0 {
            return None;
        }
        let path = String::from_utf8_lossy(&buffer[..length as usize]).to_string();
        path.rsplit('/').next().map(str::to_string)
    }

    /// Executable names of the running processes (the fallback before macOS 14).
    pub fn running_apps() -> Vec<String> {
        // SAFETY: a null buffer asks for the number of PIDs.
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if count <= 0 {
            return Vec::new();
        }
        let mut pids = vec![0i32; count as usize + 32];
        let bytes = (pids.len() * std::mem::size_of::<i32>()) as i32;
        // SAFETY: `pids` has room for `bytes` bytes.
        let filled = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        if filled <= 0 {
            return Vec::new();
        }
        pids.truncate(filled as usize);
        pids.into_iter()
            .filter(|pid| *pid > 0)
            .filter_map(executable_name)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::{snapshot, MeetingApp, Source};

    fn run(fixture: &str, running: &[&str]) -> crate::meeting::MicSnapshot {
        let (input, processes) = parse_dump(fixture);
        let apps: Vec<String> = running.iter().map(|s| s.to_string()).collect();
        snapshot(decide(input, processes.as_deref(), || apps), 0)
    }

    #[test]
    fn macos_14_names_teams_from_its_process_object() {
        let fixture = include_str!("../../tests/fixtures/meeting/macos-teams-call.txt");
        let (input, processes) = parse_dump(fixture);
        assert_eq!(input, Some(true));
        assert_eq!(processes.as_ref().map(Vec::len), Some(5));
        let snap = run(fixture, &["should not be read"]);
        assert_eq!(snap.apps, vec![MeetingApp::Teams]);
        assert_eq!(snap.source, Source::Process);
        assert!(snap.in_use);
    }

    #[test]
    fn a_meet_call_in_chrome_is_a_browser_call() {
        let snap = run(
            include_str!("../../tests/fixtures/meeting/macos-chrome-meet.txt"),
            &[],
        );
        assert_eq!(snap.apps, vec![MeetingApp::Browser]);
    }

    #[test]
    fn idle_input_means_no_call_even_with_apps_open() {
        let snap = run(
            include_str!("../../tests/fixtures/meeting/macos-idle.txt"),
            &["zoom.us"],
        );
        assert!(!snap.in_use);
        assert!(snap.apps.is_empty());
        assert_eq!(snap.source, Source::Process);
    }

    #[test]
    fn before_macos_14_the_running_meeting_apps_are_used() {
        let fixture = include_str!("../../tests/fixtures/meeting/macos-13-fallback.txt");
        let snap = run(fixture, &["Finder", "Google Chrome", "zoom.us", "Mail"]);
        assert_eq!(snap.apps, vec![MeetingApp::Zoom]);
        assert_eq!(snap.source, Source::Fallback);
        // The same system with the input idle: nothing, and the process list is not even read.
        let (_, processes) = parse_dump(fixture);
        let probe = decide(Some(false), processes.as_deref(), || panic!("not read"));
        assert!(!probe.in_use);
        // No list and no answer about the input device: unavailable.
        assert_eq!(decide(None, None, Vec::new).source, Source::Unavailable);
    }

    #[test]
    fn process_objects_that_say_nothing_fall_back_while_the_input_runs() {
        // macOS 14 with the input running but no process flagged (e.g. a system service): the running apps decide.
        let list = vec![AudioProcess {
            identity: "com.apple.controlcenter".into(),
            running_input: false,
        }];
        let probe = decide(Some(true), Some(&list), || vec!["Slack".into()]);
        assert_eq!(probe.source, Source::Fallback);
        assert_eq!(snapshot(probe, 0).apps, vec![MeetingApp::Slack]);
        assert!(recording(&[AudioProcess {
            identity: String::new(),
            running_input: true
        }])
        .is_empty());
    }
}
