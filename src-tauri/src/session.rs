//! Screen lock and system sleep, from the operating system's own events, for the "pause on lock / sleep" option.
//!
//! - **Windows**: a hidden window registered with `WTSRegisterSessionNotification` gets `WM_WTSSESSION_CHANGE`
//!   (`WTS_SESSION_LOCK` / `WTS_SESSION_UNLOCK`) and the `WM_POWERBROADCAST` suspend / resume broadcasts.
//! - **macOS**: the distributed notifications `com.apple.screenIsLocked` / `com.apple.screenIsUnlocked`, and
//!   `NSWorkspaceWillSleepNotification` / `NSWorkspaceDidWakeNotification`.
//! - **Linux**: logind on the system D-Bus: the session's `Lock` / `Unlock` signals and `LockedHint` property (set by
//!   GNOME, KDE and others), and the manager's `PrepareForSleep(bool)`.
//!
//! Each event goes to the main window as a `session-event` (`lock`, `unlock`, `suspend`, `resume`): the UI counts the
//! time from the lock as idle and asks what to do with it on return. The events stay on this computer: nothing is
//! stored, logged or sent. A system without these events (another desktop, no D-Bus) simply has none; the heartbeat's
//! sleep detection (`heartbeat.rs`) still covers a suspend.
//!
//! The OS listeners are behind `SessionSource` and the delivery behind `SessionSink`, so the logic (mapping the raw
//! codes, dropping repeats) is tested without an OS.

use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionEvent {
    Lock,
    Unlock,
    Suspend,
    Resume,
}

/// Where the events go (the main window in the app, a recorder in the tests).
pub trait SessionSink: Send + Sync {
    fn send(&self, event: SessionEvent);
}

/// An OS listener. `start` returns once it listens (its own thread or the main run loop) or could not.
pub trait SessionSource {
    fn start(self: Box<Self>, sink: Arc<dyn SessionSink>) -> Result<(), String>;
}

/// Lock / sleep state as last reported, to drop repeats: logind sends `Lock` and then a `LockedHint` change, Windows
/// may resume twice (`PBT_APMRESUMEAUTOMATIC` and `PBT_APMRESUMESUSPEND`).
#[derive(Debug, Default)]
pub struct SessionTracker {
    locked: bool,
    asleep: bool,
}

impl SessionTracker {
    /// Whether `event` changes the state (and should be passed on).
    pub fn accept(&mut self, event: SessionEvent) -> bool {
        let (slot, value) = match event {
            SessionEvent::Lock => (&mut self.locked, true),
            SessionEvent::Unlock => (&mut self.locked, false),
            SessionEvent::Suspend => (&mut self.asleep, true),
            SessionEvent::Resume => (&mut self.asleep, false),
        };
        if *slot == value {
            return false;
        }
        *slot = value;
        true
    }
}

/// Passes each event on once (see `SessionTracker`).
pub struct Deduped<S: SessionSink> {
    inner: S,
    tracker: Mutex<SessionTracker>,
}

impl<S: SessionSink> Deduped<S> {
    pub fn new(inner: S) -> Self {
        Self {
            inner,
            tracker: Mutex::new(SessionTracker::default()),
        }
    }
}

impl<S: SessionSink> SessionSink for Deduped<S> {
    fn send(&self, event: SessionEvent) {
        let accepted = self
            .tracker
            .lock()
            .map(|mut tracker| tracker.accept(event))
            .unwrap_or(true);
        if accepted {
            self.inner.send(event);
        }
    }
}

/// `WM_WTSSESSION_CHANGE` codes (`WTS_SESSION_LOCK` = 7, `WTS_SESSION_UNLOCK` = 8).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn from_wts(code: usize) -> Option<SessionEvent> {
    match code {
        0x7 => Some(SessionEvent::Lock),
        0x8 => Some(SessionEvent::Unlock),
        _ => None,
    }
}

/// `WM_POWERBROADCAST` codes (`PBT_APMSUSPEND` = 4, `PBT_APMRESUMESUSPEND` = 7, `PBT_APMRESUMEAUTOMATIC` = 0x12).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn from_power(code: usize) -> Option<SessionEvent> {
    match code {
        0x4 => Some(SessionEvent::Suspend),
        0x7 | 0x12 => Some(SessionEvent::Resume),
        _ => None,
    }
}

/// macOS notification names.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const MAC_LOCKED: &str = "com.apple.screenIsLocked";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const MAC_UNLOCKED: &str = "com.apple.screenIsUnlocked";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const MAC_WILL_SLEEP: &str = "NSWorkspaceWillSleepNotification";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const MAC_DID_WAKE: &str = "NSWorkspaceDidWakeNotification";

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn from_mac(name: &str) -> Option<SessionEvent> {
    match name {
        MAC_LOCKED => Some(SessionEvent::Lock),
        MAC_UNLOCKED => Some(SessionEvent::Unlock),
        MAC_WILL_SLEEP => Some(SessionEvent::Suspend),
        MAC_DID_WAKE => Some(SessionEvent::Resume),
        _ => None,
    }
}

/// A logind signal or property change of the session / manager: `member` (`Lock`, `Unlock`, `PrepareForSleep`,
/// `LockedHint`) and its boolean argument, if any.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn from_logind(member: &str, value: Option<bool>) -> Option<SessionEvent> {
    match (member, value) {
        ("Lock", _) => Some(SessionEvent::Lock),
        ("Unlock", _) => Some(SessionEvent::Unlock),
        ("LockedHint", Some(true)) => Some(SessionEvent::Lock),
        ("LockedHint", Some(false)) => Some(SessionEvent::Unlock),
        ("PrepareForSleep", Some(true)) => Some(SessionEvent::Suspend),
        ("PrepareForSleep", Some(false)) => Some(SessionEvent::Resume),
        _ => None,
    }
}

/// Sends the events to the main window.
struct EmitSink(tauri::AppHandle);

impl SessionSink for EmitSink {
    fn send(&self, event: SessionEvent) {
        use tauri::Emitter;
        let _ = self.0.emit_to("main", "session-event", event);
    }
}

/// Starts `source` with the de-duplicating sink. Errors are not fatal: there is just no lock event then.
pub fn start_with(
    source: Box<dyn SessionSource>,
    sink: Arc<dyn SessionSink>,
) -> Result<(), String> {
    source.start(sink)
}

/// Starts this OS's listener for the app (call from the main thread: macOS observers live on its run loop).
pub fn start(app: &tauri::AppHandle) {
    if let Some(source) = os::source() {
        let _ = start_with(source, Arc::new(Deduped::new(EmitSink(app.clone()))));
    }
}

#[cfg(target_os = "linux")]
mod os {
    use super::*;
    use std::collections::HashMap;
    use zbus::blocking::{Connection, MessageIterator, Proxy};
    use zbus::zvariant::{OwnedObjectPath, OwnedValue};

    const LOGIN1: &str = "org.freedesktop.login1";

    struct Logind;

    pub fn source() -> Option<Box<dyn SessionSource>> {
        Some(Box::new(Logind))
    }

    /// The object path of this process's logind session (none outside a session: only the sleep signal then).
    fn session_path(connection: &Connection) -> Option<OwnedObjectPath> {
        let manager = Proxy::new(
            connection,
            LOGIN1,
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
        )
        .ok()?;
        manager
            .call::<_, _, OwnedObjectPath>("GetSessionByPID", &(std::process::id()))
            .ok()
            .or_else(|| {
                let id = std::env::var("XDG_SESSION_ID").ok()?;
                manager
                    .call::<_, _, OwnedObjectPath>("GetSession", &(id.as_str()))
                    .ok()
            })
    }

    fn event_of(message: &zbus::Message, session: Option<&str>) -> Option<SessionEvent> {
        let header = message.header();
        let member = header.member()?.as_str().to_string();
        let path = header.path().map(|path| path.as_str().to_string());
        let ours = session.is_some() && path.as_deref() == session;
        match member.as_str() {
            "PrepareForSleep" => from_logind(&member, message.body().deserialize::<bool>().ok()),
            "Lock" | "Unlock" if ours => from_logind(&member, None),
            "PropertiesChanged" if ours => {
                let (_, changed, _) = message
                    .body()
                    .deserialize::<(String, HashMap<String, OwnedValue>, Vec<String>)>()
                    .ok()?;
                let hint = changed.get("LockedHint")?;
                from_logind("LockedHint", bool::try_from(hint).ok())
            }
            _ => None,
        }
    }

    impl SessionSource for Logind {
        fn start(self: Box<Self>, sink: Arc<dyn SessionSink>) -> Result<(), String> {
            let connection = Connection::system().map_err(|e| e.to_string())?;
            let session = session_path(&connection).map(|path| path.as_str().to_string());
            let rule = zbus::MatchRule::builder()
                .msg_type(zbus::message::Type::Signal)
                .sender(LOGIN1)
                .map_err(|e| e.to_string())?
                .build();
            let messages = MessageIterator::for_match_rule(rule, &connection, Some(64))
                .map_err(|e| e.to_string())?;
            std::thread::Builder::new()
                .name("session-events".into())
                .spawn(move || {
                    let _connection = connection;
                    for message in messages.flatten() {
                        if let Some(event) = event_of(&message, session.as_deref()) {
                            sink.send(event);
                        }
                    }
                })
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
    }
}

#[cfg(windows)]
mod os {
    use super::*;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
        TranslateMessage, MSG, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WNDCLASSW, WS_OVERLAPPED,
    };

    static SINK: OnceLock<Arc<dyn SessionSink>> = OnceLock::new();

    struct Wts;

    pub fn source() -> Option<Box<dyn SessionSource>> {
        Some(Box::new(Wts))
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let event = match message {
            WM_WTSSESSION_CHANGE => from_wts(wparam),
            WM_POWERBROADCAST => from_power(wparam),
            _ => None,
        };
        if let (Some(event), Some(sink)) = (event, SINK.get()) {
            sink.send(event);
        }
        DefWindowProcW(hwnd, message, wparam, lparam)
    }

    impl SessionSource for Wts {
        fn start(self: Box<Self>, sink: Arc<dyn SessionSink>) -> Result<(), String> {
            if SINK.set(sink).is_err() {
                return Err("already listening".into());
            }
            std::thread::Builder::new()
                .name("session-events".into())
                .spawn(|| unsafe {
                    let class = wide("TimeTrackSessionEvents");
                    let instance = GetModuleHandleW(std::ptr::null());
                    let mut window_class: WNDCLASSW = std::mem::zeroed();
                    window_class.lpfnWndProc = Some(window_proc);
                    window_class.hInstance = instance;
                    window_class.lpszClassName = class.as_ptr();
                    RegisterClassW(&window_class);
                    // A hidden top-level window (never shown): message-only windows get no power broadcasts.
                    let hwnd = CreateWindowExW(
                        0,
                        class.as_ptr(),
                        class.as_ptr(),
                        WS_OVERLAPPED,
                        0,
                        0,
                        0,
                        0,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        instance,
                        std::ptr::null(),
                    );
                    if hwnd.is_null() {
                        return;
                    }
                    WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
                    let mut message: MSG = std::mem::zeroed();
                    while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                        TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                })
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
    }
}

#[cfg(target_os = "macos")]
mod os {
    use super::*;
    use block2::RcBlock;
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{
        NSDistributedNotificationCenter, NSNotification, NSNotificationCenter, NSString,
    };
    use std::ptr::NonNull;

    struct Notifications;

    pub fn source() -> Option<Box<dyn SessionSource>> {
        Some(Box::new(Notifications))
    }

    fn observe(center: &NSNotificationCenter, name: &str, sink: Arc<dyn SessionSink>) {
        let block = RcBlock::new(move |note: NonNull<NSNotification>| {
            // SAFETY: the notification centre passes a valid notification for the duration of the call.
            let name = unsafe { note.as_ref() }.name().to_string();
            if let Some(event) = from_mac(&name) {
                sink.send(event);
            }
        });
        let name = NSString::from_str(name);
        // SAFETY: a plain observer block on the posting thread (the main run loop); the token is kept for the app's
        // lifetime (never removed).
        let token = unsafe {
            center.addObserverForName_object_queue_usingBlock(Some(&name), None, None, &block)
        };
        std::mem::forget(token);
    }

    impl SessionSource for Notifications {
        fn start(self: Box<Self>, sink: Arc<dyn SessionSink>) -> Result<(), String> {
            let distributed = NSDistributedNotificationCenter::defaultCenter();
            observe(&distributed, MAC_LOCKED, sink.clone());
            observe(&distributed, MAC_UNLOCKED, sink.clone());
            let workspace = NSWorkspace::sharedWorkspace().notificationCenter();
            observe(&workspace, MAC_WILL_SLEEP, sink.clone());
            observe(&workspace, MAC_DID_WAKE, sink);
            Ok(())
        }
    }
}

#[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
mod os {
    use super::*;

    pub fn source() -> Option<Box<dyn SessionSource>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<SessionEvent>>);

    impl SessionSink for Arc<Recorder> {
        fn send(&self, event: SessionEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    /// A fake OS that replays a list of raw events on `start`.
    struct Fake(Vec<SessionEvent>);

    impl SessionSource for Fake {
        fn start(self: Box<Self>, sink: Arc<dyn SessionSink>) -> Result<(), String> {
            for event in self.0 {
                sink.send(event);
            }
            Ok(())
        }
    }

    use SessionEvent::{Lock, Resume, Suspend, Unlock};

    #[test]
    fn maps_the_raw_os_codes() {
        assert_eq!(from_wts(7), Some(Lock));
        assert_eq!(from_wts(8), Some(Unlock));
        assert_eq!(from_wts(1), None);
        assert_eq!(from_power(4), Some(Suspend));
        assert_eq!(from_power(7), Some(Resume));
        assert_eq!(from_power(0x12), Some(Resume));
        assert_eq!(from_power(0xA), None);
        assert_eq!(from_mac("com.apple.screenIsLocked"), Some(Lock));
        assert_eq!(from_mac("com.apple.screenIsUnlocked"), Some(Unlock));
        assert_eq!(from_mac("NSWorkspaceWillSleepNotification"), Some(Suspend));
        assert_eq!(from_mac("NSWorkspaceDidWakeNotification"), Some(Resume));
        assert_eq!(from_mac("com.apple.screensaver.didstart"), None);
        assert_eq!(from_logind("Lock", None), Some(Lock));
        assert_eq!(from_logind("Unlock", None), Some(Unlock));
        assert_eq!(from_logind("LockedHint", Some(true)), Some(Lock));
        assert_eq!(from_logind("LockedHint", Some(false)), Some(Unlock));
        assert_eq!(from_logind("LockedHint", None), None);
        assert_eq!(from_logind("PrepareForSleep", Some(true)), Some(Suspend));
        assert_eq!(from_logind("PrepareForSleep", Some(false)), Some(Resume));
        assert_eq!(from_logind("PrepareForShutdown", Some(true)), None);
    }

    #[test]
    fn repeats_are_dropped_and_sequences_kept() {
        let recorder = Arc::new(Recorder::default());
        let sink: Arc<dyn SessionSink> = Arc::new(Deduped::new(recorder.clone()));
        // logind: Lock then LockedHint=true; Windows: two resume codes; a lock during sleep.
        let raw = vec![
            Lock, Lock, Unlock, Suspend, Lock, Resume, Resume, Unlock, Unlock,
        ];
        start_with(Box::new(Fake(raw)), sink).unwrap();
        assert_eq!(
            *recorder.0.lock().unwrap(),
            vec![Lock, Unlock, Suspend, Lock, Resume, Unlock]
        );
    }

    #[test]
    fn an_unlock_or_resume_without_a_start_is_ignored() {
        let mut tracker = SessionTracker::default();
        assert!(!tracker.accept(Unlock));
        assert!(!tracker.accept(Resume));
        assert!(tracker.accept(Suspend));
        assert!(tracker.accept(Resume));
    }

    #[test]
    fn events_cross_the_ipc_boundary_as_words() {
        assert_eq!(serde_json::to_value(Lock).unwrap(), "lock");
        assert_eq!(serde_json::to_value(Unlock).unwrap(), "unlock");
        assert_eq!(serde_json::to_value(Suspend).unwrap(), "suspend");
        assert_eq!(serde_json::to_value(Resume).unwrap(), "resume");
    }
}
