//! Wall-clock heartbeat that wakes the UI on time while its window is hidden or minimised.
//!
//! A hidden webview may throttle its own timers (WebView2, WKWebView and WebKitGTK all do, more or less), so the 30 s
//! "Still there?" check, the countdown and the friendly messages are not driven by `setInterval` in the Tauri app.
//! A plain thread polls the wall clock every second and sends the main window a `wake` event when:
//!
//! - `Tick`: 30 s passed since the previous tick (the regular check);
//! - `Deadline`: the instant the UI asked for has passed (the end of the "Still there?" countdown);
//! - `Idle`: the OS idle time just reached the threshold the UI asked for (the question appears on time, not up to
//!   30 s late);
//! - `Reminder`: the next working-hours reminder is due (start, lunch, end of the day; `schedule.ts` in the UI);
//! - `Resumed`: polls stopped for a while (the computer slept), so the UI re-checks at once (and decides itself
//!   whether a reminder missed during the sleep is still within its grace window).
//!
//! The thread only reads the clock and, while the UI asked for it, the OS "seconds since last input" counter. Nothing
//! is stored or sent: the UI decides, exactly as before, from its own clock and the same counter.
//!
//! With meeting detection on (opt-in, `mic_every_seconds`), [`Heartbeat::mic_due`] also says when to look whether a
//! meeting app holds the microphone (`meeting/`), every 15–30 s; the thread then sends the UI a `mic` event.

use serde::{Deserialize, Serialize};

/// Regular check, as the UI's former `setInterval`.
pub const TICK_MS: i64 = 30_000;
/// How often the thread looks at the clock.
pub const POLL_MS: u64 = 1_000;
/// A gap between two polls longer than this means the process (or the computer) was suspended.
pub const RESUME_GAP_MS: i64 = 15_000;
/// Bounds of the microphone check interval (meeting detection), in seconds.
pub const MIC_MIN_SECONDS: u64 = 15;
pub const MIC_MAX_SECONDS: u64 = 30;

/// What the UI wants to be woken for, besides the regular tick (`set_wake_plan`).
#[derive(Debug, Default, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakePlan {
    /// Unix milliseconds of the next deadline (end of the "Still there?" countdown); `None` when there is none.
    pub deadline_at: Option<i64>,
    /// Idle threshold in seconds while a timer runs and nobody was asked yet; `None` stops reading the idle counter.
    pub idle_after_seconds: Option<u64>,
    /// Unix milliseconds of the next working-hours reminder; `None` when there is none (absent from older UIs).
    #[serde(default)]
    pub reminder_at: Option<i64>,
    /// Meeting detection is on: look at the microphone this often (clamped to 15–30 s); `None` never looks (absent
    /// from older UIs).
    #[serde(default)]
    pub mic_every_seconds: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeReason {
    Tick,
    Deadline,
    Idle,
    Reminder,
    Resumed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Wake {
    pub reason: WakeReason,
    /// Unix milliseconds of the poll that fired.
    pub at: i64,
}

/// Pure scheduling state, polled by the thread (and by the tests with a fake clock).
#[derive(Debug, Default)]
pub struct Heartbeat {
    next_tick: Option<i64>,
    last_poll: Option<i64>,
    plan: WakePlan,
    /// The idle threshold was reported and no input happened since (one `Idle` per idle stretch).
    idle_reported: bool,
    /// Next microphone check (meeting detection); `None` checks on the next poll.
    next_mic: Option<i64>,
}

impl Heartbeat {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replaces the plan. A new deadline or threshold fires on its own terms; an idle stretch already reported is
    /// not reported again for the same threshold.
    pub fn set_plan(&mut self, plan: WakePlan) {
        if plan.idle_after_seconds != self.plan.idle_after_seconds {
            self.idle_reported = false;
        }
        if plan.mic_every_seconds != self.plan.mic_every_seconds {
            self.next_mic = None;
        }
        self.plan = plan;
    }

    /// Whether to look at the microphone at `now` (meeting detection on and its interval passed). Never while off.
    pub fn mic_due(&mut self, now: i64) -> bool {
        let Some(every) = self.plan.mic_every_seconds else {
            self.next_mic = None;
            return false;
        };
        let every = every.clamp(MIC_MIN_SECONDS, MIC_MAX_SECONDS) as i64 * 1000;
        match self.next_mic {
            // Due, or the clock went back past a whole interval: check now and restart the cadence.
            Some(at) if now < at && at - now <= every => false,
            _ => {
                self.next_mic = Some(now + every);
                true
            }
        }
    }

    #[cfg(test)]
    pub fn plan(&self) -> &WakePlan {
        &self.plan
    }

    /// One poll at wall-clock `now` (Unix ms). `idle_seconds` is only called while the plan asks for idle checks.
    pub fn poll(&mut self, now: i64, idle_seconds: impl FnOnce() -> u64) -> Option<Wake> {
        let previous = self.last_poll.replace(now);
        let wake = |reason| Some(Wake { reason, at: now });
        // The clock went back (manual change, NTP step): start the cadence again from now.
        if matches!(previous, Some(last) if now < last) {
            self.next_tick = Some(now + TICK_MS);
            return None;
        }
        if matches!(previous, Some(last) if now - last > RESUME_GAP_MS) {
            self.next_tick = Some(now + TICK_MS);
            if matches!(self.plan.deadline_at, Some(at) if now >= at) {
                self.plan.deadline_at = None;
            }
            if matches!(self.plan.reminder_at, Some(at) if now >= at) {
                self.plan.reminder_at = None;
            }
            return wake(WakeReason::Resumed);
        }
        if let Some(at) = self.plan.deadline_at {
            if now >= at {
                self.plan.deadline_at = None;
                self.next_tick = Some(now + TICK_MS);
                return wake(WakeReason::Deadline);
            }
        }
        if let Some(at) = self.plan.reminder_at {
            if now >= at {
                self.plan.reminder_at = None;
                self.next_tick = Some(now + TICK_MS);
                return wake(WakeReason::Reminder);
            }
        }
        if let Some(threshold) = self.plan.idle_after_seconds {
            if idle_seconds() >= threshold {
                if !self.idle_reported {
                    self.idle_reported = true;
                    self.next_tick = Some(now + TICK_MS);
                    return wake(WakeReason::Idle);
                }
            } else {
                self.idle_reported = false;
            }
        }
        match self.next_tick {
            Some(at) if now >= at => {
                self.next_tick = Some(now + TICK_MS);
                wake(WakeReason::Tick)
            }
            Some(_) => None,
            None => {
                self.next_tick = Some(now + TICK_MS);
                None
            }
        }
    }
}

/// Unix milliseconds of the system clock (the wall clock the UI also uses).
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_762_300_000_000;

    /// Polls every second from `from` to `to` (inclusive) and returns what fired.
    fn run(hb: &mut Heartbeat, from: i64, to: i64, idle: impl Fn(i64) -> u64) -> Vec<Wake> {
        let mut fired = Vec::new();
        let mut now = from;
        while now <= to {
            if let Some(wake) = hb.poll(now, || idle(now)) {
                fired.push(wake);
            }
            now += POLL_MS as i64;
        }
        fired
    }

    #[test]
    fn ticks_every_30_seconds_of_wall_clock() {
        let mut hb = Heartbeat::new();
        let fired = run(&mut hb, T0, T0 + 95_000, |_| 0);
        let at: Vec<i64> = fired.iter().map(|w| w.at - T0).collect();
        assert_eq!(at, vec![30_000, 60_000, 90_000]);
        assert!(fired.iter().all(|w| w.reason == WakeReason::Tick));
    }

    #[test]
    fn deadline_fires_once_on_the_second_it_passes() {
        let mut hb = Heartbeat::new();
        hb.set_plan(WakePlan {
            deadline_at: Some(T0 + 12_500),
            idle_after_seconds: None,
            reminder_at: None,
            ..WakePlan::default()
        });
        let fired = run(&mut hb, T0, T0 + 29_000, |_| 0);
        assert_eq!(
            fired,
            vec![Wake {
                reason: WakeReason::Deadline,
                at: T0 + 13_000
            }]
        );
        assert_eq!(hb.plan().deadline_at, None);
        // The regular tick restarts from the deadline (no double check right after it).
        let next = run(&mut hb, T0 + 30_000, T0 + 43_000, |_| 0);
        assert_eq!(next[0].at, T0 + 43_000);
    }

    #[test]
    fn idle_threshold_fires_on_time_and_once_per_idle_stretch() {
        let mut hb = Heartbeat::new();
        hb.set_plan(WakePlan {
            deadline_at: None,
            idle_after_seconds: Some(300),
            reminder_at: None,
            ..WakePlan::default()
        });
        // Idle since T0 - 290 s: the threshold is reached at T0 + 10 s.
        let idle = |now: i64| ((now - (T0 - 290_000)) / 1000) as u64;
        let fired = run(&mut hb, T0, T0 + 20_000, idle);
        assert_eq!(
            fired,
            vec![Wake {
                reason: WakeReason::Idle,
                at: T0 + 10_000
            }]
        );
        // Still idle: no second report, only the regular tick.
        let later = run(&mut hb, T0 + 21_000, T0 + 45_000, idle);
        assert_eq!(later.len(), 1);
        assert_eq!(later[0].reason, WakeReason::Tick);
        // Input, then idle again: reported again.
        assert_eq!(hb.poll(T0 + 46_000, || 0), None);
        assert_eq!(
            hb.poll(T0 + 47_000, || 301).map(|w| w.reason),
            Some(WakeReason::Idle)
        );
    }

    #[test]
    fn idle_counter_is_not_read_without_a_threshold() {
        let mut hb = Heartbeat::new();
        let mut reads = 0;
        for second in 0..40 {
            hb.poll(T0 + second * 1000, || {
                reads += 1;
                0
            });
        }
        assert_eq!(reads, 0);
    }

    #[test]
    fn a_sleep_gap_wakes_the_ui_at_once_and_drops_a_passed_deadline() {
        let mut hb = Heartbeat::new();
        hb.set_plan(WakePlan {
            deadline_at: Some(T0 + 60_000),
            idle_after_seconds: None,
            reminder_at: None,
            ..WakePlan::default()
        });
        assert_eq!(hb.poll(T0, || 0), None);
        // The lid closed at T0 and opened 20 minutes later.
        let wake = hb.poll(T0 + 20 * 60_000, || 0).expect("wake after sleep");
        assert_eq!(wake.reason, WakeReason::Resumed);
        assert_eq!(hb.plan().deadline_at, None);
        // Back to the 30 s cadence from the wake-up.
        let fired = run(
            &mut hb,
            T0 + 20 * 60_000 + 1000,
            T0 + 20 * 60_000 + 31_000,
            |_| 0,
        );
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].at, T0 + 20 * 60_000 + 30_000);
    }

    #[test]
    fn a_reminder_fires_once_on_time() {
        let mut hb = Heartbeat::new();
        hb.set_plan(WakePlan {
            deadline_at: None,
            idle_after_seconds: None,
            reminder_at: Some(T0 + 7_200),
            ..WakePlan::default()
        });
        let fired = run(&mut hb, T0, T0 + 20_000, |_| 0);
        assert_eq!(
            fired,
            vec![Wake {
                reason: WakeReason::Reminder,
                at: T0 + 8_000
            }]
        );
        assert_eq!(hb.plan().reminder_at, None);
    }

    #[test]
    fn a_reminder_passed_during_sleep_becomes_one_resumed_wake() {
        let mut hb = Heartbeat::new();
        hb.set_plan(WakePlan {
            deadline_at: None,
            idle_after_seconds: None,
            reminder_at: Some(T0 + 60_000),
            ..WakePlan::default()
        });
        assert_eq!(hb.poll(T0, || 0), None);
        let wake = hb.poll(T0 + 3 * 3_600_000, || 0).expect("wake after sleep");
        assert_eq!(wake.reason, WakeReason::Resumed);
        assert_eq!(hb.plan().reminder_at, None);
        // No second, stale wake for it afterwards.
        let fired = run(
            &mut hb,
            T0 + 3 * 3_600_000 + 1000,
            T0 + 3 * 3_600_000 + 29_000,
            |_| 0,
        );
        assert!(fired.is_empty());
    }

    #[test]
    fn clock_going_back_restarts_the_cadence_without_firing() {
        let mut hb = Heartbeat::new();
        assert_eq!(hb.poll(T0, || 0), None);
        assert_eq!(hb.poll(T0 - 3_600_000, || 0), None);
        let fired = run(&mut hb, T0 - 3_599_000, T0 - 3_570_000, |_| 0);
        assert_eq!(
            fired.iter().map(|w| w.at).collect::<Vec<_>>(),
            vec![T0 - 3_570_000]
        );
    }

    #[test]
    fn a_new_threshold_may_report_again() {
        let mut hb = Heartbeat::new();
        hb.set_plan(WakePlan {
            deadline_at: None,
            idle_after_seconds: Some(60),
            reminder_at: None,
            ..WakePlan::default()
        });
        assert_eq!(hb.poll(T0, || 61).map(|w| w.reason), Some(WakeReason::Idle));
        hb.set_plan(WakePlan {
            deadline_at: None,
            idle_after_seconds: Some(60),
            reminder_at: None,
            ..WakePlan::default()
        });
        assert_eq!(hb.poll(T0 + 1000, || 62), None);
        hb.set_plan(WakePlan {
            deadline_at: None,
            idle_after_seconds: Some(30),
            reminder_at: None,
            ..WakePlan::default()
        });
        assert_eq!(
            hb.poll(T0 + 2000, || 63).map(|w| w.reason),
            Some(WakeReason::Idle)
        );
    }

    #[test]
    fn the_microphone_is_only_checked_while_meeting_detection_is_on() {
        let mut hb = Heartbeat::new();
        let checks = |hb: &mut Heartbeat, from: i64, to: i64| {
            (from..=to)
                .step_by(POLL_MS as usize)
                .filter(|now| hb.mic_due(*now))
                .map(|now| now - T0)
                .collect::<Vec<_>>()
        };
        assert!(checks(&mut hb, T0, T0 + 60_000).is_empty());
        hb.set_plan(WakePlan {
            mic_every_seconds: Some(20),
            ..WakePlan::default()
        });
        // At once when turned on, then every 20 s.
        assert_eq!(
            checks(&mut hb, T0, T0 + 60_000),
            vec![0, 20_000, 40_000, 60_000]
        );
        // Out-of-range intervals are clamped to 15–30 s.
        hb.set_plan(WakePlan {
            mic_every_seconds: Some(1),
            ..WakePlan::default()
        });
        assert_eq!(
            checks(&mut hb, T0 + 61_000, T0 + 91_000),
            vec![61_000, 76_000, 91_000]
        );
        hb.set_plan(WakePlan {
            mic_every_seconds: Some(600),
            ..WakePlan::default()
        });
        assert_eq!(
            checks(&mut hb, T0 + 92_000, T0 + 152_000),
            vec![92_000, 122_000, 152_000]
        );
        // The clock going back more than an interval checks at once.
        assert!(hb.mic_due(T0));
        // Turned off: never again, and turning it on checks at once.
        hb.set_plan(WakePlan::default());
        assert!(!hb.mic_due(T0 + 500_000));
        hb.set_plan(WakePlan {
            mic_every_seconds: Some(20),
            ..WakePlan::default()
        });
        assert!(hb.mic_due(T0 + 500_001));
        assert!(!hb.mic_due(T0 + 500_002));
    }

    #[test]
    fn plan_and_wake_cross_the_ipc_boundary() {
        let plan: WakePlan =
            serde_json::from_str(r#"{"deadlineAt":1762300012500,"idleAfterSeconds":300}"#).unwrap();
        assert_eq!(plan.deadline_at, Some(1_762_300_012_500));
        assert_eq!(plan.idle_after_seconds, Some(300));
        // An older UI sends no reminder and no microphone interval.
        assert_eq!(plan.reminder_at, None);
        assert_eq!(plan.mic_every_seconds, None);
        let plan: WakePlan = serde_json::from_str(
            r#"{"deadlineAt":null,"idleAfterSeconds":null,"reminderAt":null,"micEverySeconds":20}"#,
        )
        .unwrap();
        assert_eq!(plan.mic_every_seconds, Some(20));
        let plan: WakePlan = serde_json::from_str(
            r#"{"deadlineAt":null,"idleAfterSeconds":null,"reminderAt":1762300060000}"#,
        )
        .unwrap();
        assert_eq!(plan.reminder_at, Some(1_762_300_060_000));
        assert_eq!(
            serde_json::to_value(WakeReason::Reminder).unwrap(),
            "reminder"
        );
        let json = serde_json::to_value(Wake {
            reason: WakeReason::Resumed,
            at: 5,
        })
        .unwrap();
        assert_eq!(json["reason"], "resumed");
        assert_eq!(json["at"], 5);
        assert!(now_ms() > T0);
    }
}
