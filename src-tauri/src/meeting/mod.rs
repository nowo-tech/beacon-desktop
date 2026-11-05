//! Meeting detection (opt-in, local only): is the microphone in use, and is a known meeting app holding it?
//!
//! Two facts are read, nothing else: whether the microphone is in use, and the identity of the apps that hold it
//! (executable name, macOS bundle id or Windows package name). The identity is reduced at once to a fixed app id
//! (`teams`, `zoom`, …, `browser` for a call in a web browser) or dropped; paths and unknown apps never leave this
//! module. No window titles, URLs, chats or audio are read, and nothing is stored or sent: the heartbeat hands the UI a
//! `mic` event every 15–30 s while the user has the feature on (Settings, off by default), and the UI decides whether
//! to ask "Are you in a meeting?".
//!
//! Per OS (each behind [`MicDetector`], with its parsing kept pure and tested on recorded fixtures):
//!
//! - **Windows** ([`windows`]): the privacy "Recent activity" store of Windows 10/11, `HKCU\…\CapabilityAccessManager\
//!   ConsentStore\microphone`: one key per packaged app and per executable path (`NonPackaged`), with
//!   `LastUsedTimeStop == 0` while the app uses the microphone.
//! - **macOS** ([`macos`]): CoreAudio. `kAudioDevicePropertyDeviceIsRunningSomewhere` on the default input device, and
//!   on macOS 14+ the audio process objects (`kAudioHardwarePropertyProcessObjectList`) with their bundle id and
//!   "running input" flag. Older systems fall back to the running apps (known meeting apps while the mic is in use).
//! - **Linux** ([`linux`]): the PulseAudio / PipeWire (pipewire-pulse) recording streams (`pactl list
//!   source-outputs`, not corked), with their `application.process.binary`; `pw-dump` when `pactl` is missing.

pub mod linux;
pub mod macos;
pub mod windows;

use serde::Serialize;

/// Known meeting apps. A browser stands for any web meeting (Google Meet, Jitsi, Teams or Zoom on the web): the tab
/// or its URL is never read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MeetingApp {
    Teams,
    Zoom,
    Webex,
    Slack,
    Discord,
    Skype,
    Goto,
    Jitsi,
    Browser,
}

/// How the holders were found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// The OS named the apps that hold the microphone.
    Process,
    /// The OS only said the microphone is in use; the apps are the known meeting apps running (macOS before 14).
    Fallback,
    /// Not readable on this system (no audio server, API missing): nothing is in use as far as the app knows.
    Unavailable,
}

/// What one probe found: raw identities, reduced by [`snapshot`] before anything leaves this module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    pub in_use: bool,
    pub holders: Vec<String>,
    pub source: Source,
}

impl Probe {
    pub fn unavailable() -> Self {
        Self {
            in_use: false,
            holders: Vec::new(),
            source: Source::Unavailable,
        }
    }

    /// The holders an OS named (the microphone is in use when there is one). The Windows and Linux detectors use it;
    /// macOS builds its probe from CoreAudio and only the tests call it there.
    #[cfg_attr(all(target_os = "macos", not(test)), allow(dead_code))]
    pub fn named(holders: Vec<String>) -> Self {
        Self {
            in_use: !holders.is_empty(),
            holders,
            source: Source::Process,
        }
    }
}

/// One OS's way to find who holds the microphone. Called from the heartbeat thread, outside its lock, every 15–30 s
/// while the UI asks for it; must be cheap and never block for long.
pub trait MicDetector: Send {
    fn probe(&mut self) -> Probe;
}

/// What the UI receives (`mic` event): only the known app ids, never paths or unknown apps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicSnapshot {
    /// Unix milliseconds of the probe.
    pub at: i64,
    pub in_use: bool,
    pub apps: Vec<MeetingApp>,
    pub source: Source,
}

/// Reduces a probe to the known meeting apps (sorted, without repeats).
pub fn snapshot(probe: Probe, at: i64) -> MicSnapshot {
    let mut apps: Vec<MeetingApp> = probe.holders.iter().filter_map(|id| classify(id)).collect();
    apps.sort();
    apps.dedup();
    MicSnapshot {
        at,
        in_use: probe.in_use || !apps.is_empty(),
        apps,
        source: probe.source,
    }
}

/// The detector of this OS.
pub fn system_detector() -> Box<dyn MicDetector> {
    #[cfg(windows)]
    return Box::new(windows::ConsentStore);
    #[cfg(target_os = "macos")]
    return Box::new(macos::CoreAudio);
    #[cfg(target_os = "linux")]
    return Box::new(linux::AudioServer::default());
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    return Box::new(Unsupported);
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
struct Unsupported;

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
impl MicDetector for Unsupported {
    fn probe(&mut self) -> Probe {
        Probe::unavailable()
    }
}

/// macOS bundle ids (prefix match, so helpers such as `com.google.Chrome.helper` count).
const BUNDLES: &[(&str, MeetingApp)] = &[
    ("com.microsoft.teams", MeetingApp::Teams),
    ("us.zoom.", MeetingApp::Zoom),
    ("cisco-systems.spark", MeetingApp::Webex),
    ("com.cisco.webex", MeetingApp::Webex),
    ("com.webex.", MeetingApp::Webex),
    ("com.tinyspeck.slackmacgap", MeetingApp::Slack),
    ("com.hnc.discord", MeetingApp::Discord),
    ("com.skype.", MeetingApp::Skype),
    ("com.logmein.", MeetingApp::Goto),
    ("org.jitsi.", MeetingApp::Jitsi),
    ("com.google.chrome", MeetingApp::Browser),
    ("org.chromium.", MeetingApp::Browser),
    ("com.apple.safari", MeetingApp::Browser),
    // Safari and other WebKit views capture through the WebKit GPU / web content processes.
    ("com.apple.webkit.", MeetingApp::Browser),
    ("org.mozilla.firefox", MeetingApp::Browser),
    ("com.microsoft.edgemac", MeetingApp::Browser),
    ("com.brave.browser", MeetingApp::Browser),
    ("company.thebrowser.", MeetingApp::Browser),
    ("com.operasoftware.", MeetingApp::Browser),
    ("com.vivaldi.vivaldi", MeetingApp::Browser),
];

/// Windows package family names (the part before `_`).
const PACKAGES: &[(&str, MeetingApp)] = &[
    ("msteams", MeetingApp::Teams),
    ("microsoftteams", MeetingApp::Teams),
    ("microsoft.skypeapp", MeetingApp::Skype),
    ("91750d7e.slack", MeetingApp::Slack),
    ("zoom.zoom", MeetingApp::Zoom),
    ("microsoft.microsoftedge", MeetingApp::Browser),
];

/// Executable / app names (lower case, without `.exe`, without a macOS " Helper …" suffix).
const EXECUTABLES: &[(&str, MeetingApp)] = &[
    ("ms-teams", MeetingApp::Teams),
    ("msteams", MeetingApp::Teams),
    ("teams", MeetingApp::Teams),
    ("teams-for-linux", MeetingApp::Teams),
    ("microsoft teams", MeetingApp::Teams),
    ("microsoft teams classic", MeetingApp::Teams),
    ("zoom", MeetingApp::Zoom),
    ("zoom.us", MeetingApp::Zoom),
    ("zoomwebinar", MeetingApp::Zoom),
    ("webex", MeetingApp::Webex),
    ("ciscowebexmeetings", MeetingApp::Webex),
    ("ciscocollabhost", MeetingApp::Webex),
    ("atmgr", MeetingApp::Webex),
    ("webexhost", MeetingApp::Webex),
    ("slack", MeetingApp::Slack),
    ("discord", MeetingApp::Discord),
    ("discordptb", MeetingApp::Discord),
    ("discordcanary", MeetingApp::Discord),
    ("skype", MeetingApp::Skype),
    ("skypeforlinux", MeetingApp::Skype),
    ("goto", MeetingApp::Goto),
    ("gotomeeting", MeetingApp::Goto),
    ("g2mcomm", MeetingApp::Goto),
    ("jitsi meet", MeetingApp::Jitsi),
    ("jitsi-meet", MeetingApp::Jitsi),
    ("chrome", MeetingApp::Browser),
    ("google-chrome", MeetingApp::Browser),
    ("google chrome", MeetingApp::Browser),
    ("chromium", MeetingApp::Browser),
    ("chromium-browser", MeetingApp::Browser),
    ("firefox", MeetingApp::Browser),
    ("firefox-bin", MeetingApp::Browser),
    ("firefox-esr", MeetingApp::Browser),
    ("msedge", MeetingApp::Browser),
    ("microsoft-edge", MeetingApp::Browser),
    ("microsoft edge", MeetingApp::Browser),
    ("brave", MeetingApp::Browser),
    ("brave-browser", MeetingApp::Browser),
    ("brave browser", MeetingApp::Browser),
    ("opera", MeetingApp::Browser),
    ("vivaldi", MeetingApp::Browser),
    ("vivaldi-bin", MeetingApp::Browser),
    ("safari", MeetingApp::Browser),
    ("arc", MeetingApp::Browser),
];

/// The known meeting app behind an identity (bundle id, package family name, executable name or path), or `None`.
pub fn classify(identity: &str) -> Option<MeetingApp> {
    let lower = identity.trim().to_lowercase();
    if lower.is_empty() {
        return None;
    }
    if let Some((_, app)) = BUNDLES.iter().find(|(prefix, _)| lower.starts_with(prefix)) {
        return Some(*app);
    }
    // Paths: `/usr/lib/slack/slack`, `C:\…\Zoom.exe`, and the registry's `C:#…#Zoom.exe`.
    let name = lower
        .rsplit(['/', '\\', '#'])
        .find(|part| !part.is_empty())
        .unwrap_or(&lower);
    if let Some((family, _)) = name.split_once('_') {
        if let Some((_, app)) = PACKAGES.iter().find(|(known, _)| *known == family) {
            return Some(*app);
        }
    }
    let name = name.strip_suffix(".exe").unwrap_or(name);
    let name = name.split(" helper").next().unwrap_or(name).trim();
    EXECUTABLES
        .iter()
        .find(|(known, _)| *known == name)
        .map(|(_, app)| *app)
}

/// The known meeting apps among running app names, dedicated apps first: browsers only when none is running.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn likely_holders(running: &[String]) -> Vec<String> {
    let known: Vec<(&String, MeetingApp)> = running
        .iter()
        .filter_map(|name| classify(name).map(|app| (name, app)))
        .collect();
    let dedicated: Vec<String> = known
        .iter()
        .filter(|(_, app)| *app != MeetingApp::Browser)
        .map(|(name, _)| (*name).clone())
        .collect();
    if !dedicated.is_empty() {
        return dedicated;
    }
    known.into_iter().map(|(name, _)| name.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_of_every_os_map_to_the_known_apps() {
        let cases: &[(&str, Option<MeetingApp>)] = &[
            ("MSTeams_8wekyb3d8bbwe", Some(MeetingApp::Teams)),
            ("ms-teams", Some(MeetingApp::Teams)),
            (
                "C:#Users#ana#AppData#Local#Microsoft#Teams#current#Teams.exe",
                Some(MeetingApp::Teams),
            ),
            ("com.microsoft.teams2", Some(MeetingApp::Teams)),
            ("teams-for-linux", Some(MeetingApp::Teams)),
            (
                "C:#Users#ana#AppData#Roaming#Zoom#bin#Zoom.exe",
                Some(MeetingApp::Zoom),
            ),
            ("us.zoom.xos", Some(MeetingApp::Zoom)),
            (
                "/Applications/zoom.us.app/Contents/MacOS/zoom.us",
                Some(MeetingApp::Zoom),
            ),
            ("zoom", Some(MeetingApp::Zoom)),
            ("Cisco-Systems.Spark", Some(MeetingApp::Webex)),
            ("CiscoCollabHost", Some(MeetingApp::Webex)),
            ("91750D7E.Slack_8she8kybcnzg4", Some(MeetingApp::Slack)),
            ("com.tinyspeck.slackmacgap.helper", Some(MeetingApp::Slack)),
            ("/usr/lib/slack/slack", Some(MeetingApp::Slack)),
            ("Discord.exe", Some(MeetingApp::Discord)),
            ("Microsoft.SkypeApp_kzf8qxf38zg5c", Some(MeetingApp::Skype)),
            ("g2mcomm.exe", Some(MeetingApp::Goto)),
            ("org.jitsi.jitsi-meet", Some(MeetingApp::Jitsi)),
            (
                "C:#Program Files#Google#Chrome#Application#chrome.exe",
                Some(MeetingApp::Browser),
            ),
            ("com.google.Chrome.helper", Some(MeetingApp::Browser)),
            ("Google Chrome Helper (Renderer)", Some(MeetingApp::Browser)),
            ("com.apple.WebKit.GPU", Some(MeetingApp::Browser)),
            ("firefox-bin", Some(MeetingApp::Browser)),
            ("msedge.exe", Some(MeetingApp::Browser)),
            // Not meeting apps: dictation, recorders, the system itself.
            ("com.apple.controlcenter", None),
            ("C:#Windows#System32#SoundRecorder.exe", None),
            ("Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe", None),
            ("pavucontrol", None),
            ("obs", None),
            ("", None),
            ("   ", None),
            ("teamspeak", None),
            ("zoomit.exe", None),
        ];
        for (identity, expected) in cases {
            assert_eq!(classify(identity), *expected, "{identity}");
        }
    }

    #[test]
    fn snapshots_keep_only_known_app_ids() {
        let probe = Probe::named(vec![
            "C:#Program Files#Google#Chrome#Application#chrome.exe".into(),
            "MSTeams_8wekyb3d8bbwe".into(),
            "C:#Users#ana#secret-project#recorder.exe".into(),
            "ms-teams".into(),
        ]);
        let snap = snapshot(probe, 42);
        assert_eq!(snap.apps, vec![MeetingApp::Teams, MeetingApp::Browser]);
        assert!(snap.in_use);
        let json = serde_json::to_value(&snap).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"at": 42, "inUse": true, "apps": ["teams", "browser"], "source": "process"})
        );
        // Nothing of the unknown path reaches the UI.
        assert!(!json.to_string().contains("secret"));
        // An unknown recorder alone: in use, no meeting app.
        let other = snapshot(Probe::named(vec!["SoundRecorder.exe".into()]), 1);
        assert!(other.in_use && other.apps.is_empty());
        let none = snapshot(Probe::unavailable(), 2);
        assert_eq!(
            serde_json::to_value(&none).unwrap(),
            serde_json::json!({"at": 2, "inUse": false, "apps": [], "source": "unavailable"})
        );
    }

    #[test]
    fn running_apps_fall_back_to_dedicated_meeting_apps_first() {
        let names = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            likely_holders(&names(&["Finder", "Google Chrome", "zoom.us", "Slack"])),
            names(&["zoom.us", "Slack"])
        );
        assert_eq!(
            likely_holders(&names(&["Finder", "Safari"])),
            names(&["Safari"])
        );
        assert!(likely_holders(&names(&["Finder", "Notes"])).is_empty());
    }

    #[test]
    fn the_system_detector_exists_on_every_os() {
        // Probing the real OS in CI only checks it does not panic; what it finds depends on the machine.
        let mut detector = system_detector();
        let probe = detector.probe();
        assert!(probe.in_use || probe.holders.is_empty() || probe.source != Source::Process);
    }
}
