//! Linux: the recording streams of the sound server.
//!
//! `pactl list source-outputs` (PulseAudio, and PipeWire through pipewire-pulse, the default on current desktops)
//! lists one "Source Output" per app recording from a microphone, with `Corked: yes` while paused and the app's
//! `application.process.binary`. Without `pactl`, `pw-dump` gives the same from PipeWire (`Stream/Input/Audio` nodes in
//! the `running` state). Only the binary name (or, when the sandbox hides it, `application.name`) is kept; media names,
//! window titles and the rest of the properties are skipped.

/// The apps recording now, from `pactl list source-outputs` (run with `LC_ALL=C`).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_pactl(text: &str) -> Vec<String> {
    #[derive(Default)]
    struct Stream {
        corked: bool,
        binary: Option<String>,
        name: Option<String>,
    }
    let finish = |stream: Stream, out: &mut Vec<String>| {
        if !stream.corked {
            if let Some(holder) = stream.binary.or(stream.name) {
                out.push(holder);
            }
        }
    };
    let mut out = Vec::new();
    let mut current: Option<Stream> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Source Output #") {
            if let Some(stream) = current.take() {
                finish(stream, &mut out);
            }
            current = Some(Stream::default());
            continue;
        }
        let Some(stream) = current.as_mut() else {
            continue;
        };
        if let Some(value) = trimmed.strip_prefix("Corked:") {
            stream.corked = value.trim() == "yes";
        } else if let Some((key, value)) = trimmed.split_once(" = ") {
            let value = value.trim().trim_matches('"').to_string();
            match key.trim() {
                "application.process.binary" if !value.is_empty() => stream.binary = Some(value),
                "application.name" if !value.is_empty() => stream.name = Some(value),
                _ => {}
            }
        }
    }
    if let Some(stream) = current {
        finish(stream, &mut out);
    }
    out
}

/// The apps recording now, from `pw-dump` (JSON): running `Stream/Input/Audio` nodes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_pw_dump(json: &str) -> Option<Vec<String>> {
    let objects: Vec<serde_json::Value> = serde_json::from_str(json).ok()?;
    Some(
        objects
            .iter()
            .filter(|object| object["type"] == "PipeWire:Interface:Node")
            .filter(|object| object["info"]["state"] == "running")
            .filter(|object| object["info"]["props"]["media.class"] == "Stream/Input/Audio")
            .filter_map(|object| {
                let props = &object["info"]["props"];
                props["application.process.binary"]
                    .as_str()
                    .or_else(|| props["application.name"].as_str())
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            })
            .collect(),
    )
}

/// The sound server, through `pactl` (or `pw-dump`), each run bounded by a short timeout.
#[cfg(target_os = "linux")]
#[derive(Default)]
pub struct AudioServer {
    /// `pactl` was not found: go straight to `pw-dump`.
    no_pactl: bool,
}

#[cfg(target_os = "linux")]
impl super::MicDetector for AudioServer {
    fn probe(&mut self) -> super::Probe {
        if !self.no_pactl {
            match run(&["pactl", "list", "source-outputs"]) {
                Ok(Some(text)) => return super::Probe::named(parse_pactl(&text)),
                Ok(None) => return super::Probe::unavailable(),
                Err(_) => self.no_pactl = true,
            }
        }
        match run(&["pw-dump"]) {
            Ok(Some(json)) => parse_pw_dump(&json)
                .map(super::Probe::named)
                .unwrap_or_else(super::Probe::unavailable),
            _ => super::Probe::unavailable(),
        }
    }
}

/// Runs a command in the C locale for at most `TIMEOUT`. `Err` when it cannot be started (not installed), `Ok(None)`
/// when it failed or took too long.
#[cfg(target_os = "linux")]
fn run(argv: &[&str]) -> std::io::Result<Option<String>> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const TIMEOUT: Duration = Duration::from_secs(3);
    let mut child = Command::new(argv[0])
        .args(&argv[1..])
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    // Read on a side thread, so a long output never fills the pipe and blocks the child.
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        stdout.read_to_string(&mut text).map(|_| text)
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < TIMEOUT => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let text = reader.join().ok().and_then(Result::ok);
    Ok(match (status, text) {
        (Some(status), Some(text)) if status.success() => Some(text),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meeting::{snapshot, MeetingApp, Probe};

    #[test]
    fn pipewire_pulse_lists_zoom_and_skips_the_paused_meter() {
        let fixture = include_str!("../../tests/fixtures/meeting/linux-pactl-pipewire-zoom.txt");
        assert_eq!(parse_pactl(fixture), vec!["zoom".to_string()]);
        let snap = snapshot(Probe::named(parse_pactl(fixture)), 0);
        assert_eq!(snap.apps, vec![MeetingApp::Zoom]);
    }

    #[test]
    fn pulseaudio_lists_firefox_and_an_unknown_recorder() {
        let fixture = include_str!("../../tests/fixtures/meeting/linux-pactl-pulse-firefox.txt");
        assert_eq!(
            parse_pactl(fixture),
            vec!["firefox".to_string(), "Audio Recorder".to_string()]
        );
        let snap = snapshot(Probe::named(parse_pactl(fixture)), 0);
        assert_eq!(snap.apps, vec![MeetingApp::Browser]);
        assert!(snap.in_use);
    }

    #[test]
    fn no_source_outputs_means_no_call() {
        assert!(parse_pactl("").is_empty());
        assert!(parse_pactl("Corked: no\n\tapplication.process.binary = \"zoom\"\n").is_empty());
        assert!(!Probe::named(parse_pactl("")).in_use);
    }

    #[test]
    fn pw_dump_lists_running_input_streams_only() {
        let fixture = include_str!("../../tests/fixtures/meeting/linux-pw-dump-teams.json");
        assert_eq!(
            parse_pw_dump(fixture),
            Some(vec!["teams-for-linux".to_string()])
        );
        let snap = snapshot(Probe::named(parse_pw_dump(fixture).unwrap()), 0);
        assert_eq!(snap.apps, vec![MeetingApp::Teams]);
        assert_eq!(parse_pw_dump("not json"), None);
        assert_eq!(parse_pw_dump("[]"), Some(vec![]));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn commands_report_missing_tools_and_failures() {
        assert!(run(&["/nonexistent/ttd-no-such-tool"]).is_err());
        assert_eq!(run(&["false"]).unwrap(), None);
        assert_eq!(run(&["echo", "ok"]).unwrap().as_deref(), Some("ok\n"));
        let mut server = AudioServer { no_pactl: true };
        // Whatever the machine has, a probe never panics.
        let _ = crate::meeting::MicDetector::probe(&mut server);
    }
}
