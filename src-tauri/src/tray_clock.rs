//! Elapsed time of the running timer in the tray: the menu-bar title on macOS (and the AppIndicator label on Linux
//! desktops that show one), the tooltip on every system.
//!
//! The UI sends the templates once per change of timer (`set_tray_status` with a `clock`), already translated; the
//! heartbeat thread (`heartbeat.rs`) then refreshes the texts on its own every minute, so the tray stays right while
//! the window is hidden and its timers are throttled. Only the start instant and the translated templates are kept;
//! nothing is stored or sent.

use serde::Deserialize;

/// What the UI sends while a timer runs. `{time}` is the entry's elapsed time and `{today}` the day's total, both
/// `H:MM` like the UI (`formatHoursMinutes`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockSpec {
    /// Unix milliseconds of the running entry's start.
    pub started_at: i64,
    /// Menu-bar title, e.g. `{time} Fix login`.
    pub title: String,
    /// Tooltip, e.g. `Fix login — {time} (today {today})`.
    pub tooltip: String,
    /// Seconds tracked today without this entry's elapsed time (may be negative when the entry began yesterday).
    #[serde(default)]
    pub today_base_seconds: i64,
}

/// Title and tooltip to show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClockText {
    pub title: String,
    pub tooltip: String,
}

/// `H:MM` of a number of seconds (never negative), as `formatHoursMinutes` in `src/lib/summary.ts`.
pub fn hours_minutes(seconds: i64) -> String {
    let minutes = seconds.max(0) / 60;
    format!("{}:{:02}", minutes / 60, minutes % 60)
}

/// The texts of `spec` at `now` (Unix ms).
pub fn render(spec: &ClockSpec, now: i64) -> ClockText {
    let elapsed = (now - spec.started_at).max(0) / 1000;
    let time = hours_minutes(elapsed);
    let today = hours_minutes(spec.today_base_seconds + elapsed);
    let fill = |template: &str| template.replace("{time}", &time).replace("{today}", &today);
    ClockText {
        title: fill(&spec.title),
        tooltip: fill(&spec.tooltip),
    }
}

/// The running clock and the texts last put in the tray (so the tray is only touched when the minute changes).
#[derive(Debug, Default)]
pub struct TrayClock {
    spec: Option<ClockSpec>,
    shown: Option<ClockText>,
}

impl TrayClock {
    pub fn new() -> Self {
        Self::default()
    }

    /// A new clock from the UI (`None`: no timer runs). Returns the texts to show now, if any.
    pub fn set(&mut self, spec: Option<ClockSpec>, now: i64) -> Option<ClockText> {
        self.spec = spec;
        self.shown = None;
        self.poll(now)
    }

    /// One heartbeat poll: the new texts when they changed since the last ones shown, else `None`.
    pub fn poll(&mut self, now: i64) -> Option<ClockText> {
        let text = render(self.spec.as_ref()?, now);
        if self.shown.as_ref() == Some(&text) {
            return None;
        }
        self.shown = Some(text.clone());
        Some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_762_300_000_000;

    fn spec() -> ClockSpec {
        ClockSpec {
            started_at: T0,
            title: "{time} Fix login".into(),
            tooltip: "Fix login — {time} (today {today})".into(),
            today_base_seconds: 3_600,
        }
    }

    #[test]
    fn formats_like_the_ui() {
        assert_eq!(hours_minutes(0), "0:00");
        assert_eq!(hours_minutes(59), "0:00");
        assert_eq!(hours_minutes(61), "0:01");
        assert_eq!(hours_minutes(3_600 * 10 + 5 * 60), "10:05");
        assert_eq!(hours_minutes(-30), "0:00");
    }

    #[test]
    fn renders_title_and_tooltip() {
        let text = render(&spec(), T0 + 65 * 60_000);
        assert_eq!(text.title, "1:05 Fix login");
        assert_eq!(text.tooltip, "Fix login — 1:05 (today 2:05)");
        // A clock a little ahead of the server: never a negative time.
        assert_eq!(render(&spec(), T0 - 5_000).title, "0:00 Fix login");
    }

    #[test]
    fn the_tray_changes_once_a_minute() {
        let mut clock = TrayClock::new();
        assert_eq!(clock.poll(T0), None);
        let first = clock.set(Some(spec()), T0 + 1_000).expect("shown at once");
        assert_eq!(first.title, "0:00 Fix login");
        let mut changes = Vec::new();
        for second in 2..=185 {
            if let Some(text) = clock.poll(T0 + second * 1_000) {
                changes.push(text.title);
            }
        }
        assert_eq!(
            changes,
            vec!["0:01 Fix login", "0:02 Fix login", "0:03 Fix login"]
        );
    }

    #[test]
    fn stopping_clears_the_clock() {
        let mut clock = TrayClock::new();
        clock.set(Some(spec()), T0);
        assert_eq!(clock.set(None, T0 + 60_000), None);
        assert_eq!(clock.poll(T0 + 120_000), None);
    }

    #[test]
    fn spec_crosses_the_ipc_boundary() {
        let spec: ClockSpec = serde_json::from_str(
            r#"{"startedAt":1762300000000,"title":"{time} A","tooltip":"A {time}","todayBaseSeconds":-120}"#,
        )
        .unwrap();
        assert_eq!(spec.today_base_seconds, -120);
        let old: ClockSpec =
            serde_json::from_str(r#"{"startedAt":1,"title":"t","tooltip":"t"}"#).unwrap();
        assert_eq!(old.today_base_seconds, 0);
    }
}
