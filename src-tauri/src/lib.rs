//! Beacon Desktop shell: tray, global shortcut, OS keychain, local idle time, the Beacon updater, the wall-clock
//! heartbeat (`heartbeat.rs`), native friendly-message notifications (`notify.rs`) and the "Still there?" window
//! (`prompt.rs`). Closing the window keeps the app (and the timer, the idle check and the messages) running in the tray.
//!
//! Privacy by design: nothing here observes the user's activity beyond the OS "seconds since last input" counter and
//! the screen lock / sleep events (`session.rs`), which never leave the device. The UI reads the counter every 30 s
//! while a timer runs (to decide when to ask "Still there?") and, with "Working without a timer?" on, during working
//! hours; it is not stored, logged or sent (only the user's answers and the entries they confirm are). With meeting
//! detection on (opt-in), the heartbeat also tells the UI whether a known meeting app holds the microphone
//! (`meeting/`): app ids only, never window titles, URLs or audio, and nothing is stored or sent.

mod autostart;
mod browser;
mod deeplink;
mod heartbeat;
mod meeting;
mod mini;
mod net;
mod notify;
mod pinning;
mod pose_art;
mod prompt;
mod realtime;
mod secret;
mod session;
mod tray_clock;

use reqwest::header::AUTHORIZATION;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent, Wry};
use tauri_plugin_updater::UpdaterExt;

/// The name people see (window and tray titles, notifications, dialogs). Only the visible name changed in 0.9.0
/// (design Q-BD-1, option A): `productName` stays "TimeTrack" because it names the install folder, the Windows
/// Uninstall key and start-at-login value, the `.app` file and the Debian package, and the identifier stays
/// `tech.nowo.timetrack` (app data, AUMID). `tests/unit/identifiers.test.ts` keeps both from drifting.
pub(crate) const APP_DISPLAY_NAME: &str = "Beacon Desktop";

const TRAY_ID: &str = "main";
/// Argument of the start-at-login entry: start hidden in the tray.
const HIDDEN_ARG: &str = "--hidden";
/// Default global shortcut. `Ctrl+Alt+T` opens a terminal on Ubuntu / GNOME; the UI can change it (Settings).
const DEFAULT_SHORTCUT: &str = "CommandOrControl+Alt+Shift+T";
/// Shortcut slots of `set_global_shortcut`: show the window and search, or "Continue the last task" (registered by the
/// UI at start; default `CommandOrControl+Alt+T` on Windows / macOS and `CommandOrControl+Alt+Shift+R` on Linux, where
/// Ctrl+Alt+T opens a terminal; the previews' `CommandOrControl+Alt+Space` is Finder search on macOS and the UI migrates
/// it; Settings can change it).
const SLOT_OPEN: &str = "open";
const SLOT_RESUME: &str = "resume";

/// Tray state kept between UI updates: the status line item and the two icon variants.
struct TrayState {
    status: Mutex<Option<MenuItem<Wry>>>,
    running: Option<Image<'static>>,
    stopped: Option<Image<'static>>,
    shortcut: Mutex<Option<String>>,
    /// "Continue the last task" shortcut (works with the window hidden).
    resume_shortcut: Mutex<Option<String>>,
    /// Elapsed time of the running timer, refreshed by the heartbeat thread (`tray_clock.rs`).
    clock: Mutex<tray_clock::TrayClock>,
    /// Unread chat messages (BD-2): the tray icon gets a red dot.
    unread: Mutex<bool>,
    running_unread: Option<Image<'static>>,
    stopped_unread: Option<Image<'static>>,
    /// Whether the timer runs (the last `set_tray_status`), so the badge keeps the right icon.
    running_now: Mutex<bool>,
}

/// Tray tooltip / title / status line, sent by the UI (translated) every ~30 s and on every timer change.
#[derive(Debug, Deserialize)]
struct TrayStatus {
    title: Option<String>,
    tooltip: String,
    status: String,
    running: bool,
    /// While a timer runs: the templates the heartbeat keeps up to date (absent from older UIs).
    #[serde(default)]
    clock: Option<tray_clock::ClockSpec>,
}

#[derive(Debug, Deserialize)]
struct TrayMenuItem {
    id: String,
    label: String,
}

/// Translated tray menu, sent by the UI when it changes (see `src/platform.ts` `TrayMenu`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayMenuSpec {
    primary: Option<TrayMenuItem>,
    switch_label: String,
    switch_to: Vec<TrayMenuItem>,
    search: String,
    open: String,
    /// "Full view" (`layout-full`) or "Compact view" (`layout-compact`): the other view; absent while signed out.
    #[serde(default)]
    layout: Option<TrayMenuItem>,
    /// Chat (BD-3b): "Open chat" (`open-chat`, with the unread count in its label) and "Pause chat notifications" /
    /// "Resume chat notifications" (`pause-chat` / `resume-chat`); absent from older UIs and while chat is off.
    #[serde(default)]
    chat: Vec<TrayMenuItem>,
    open_beacon: Option<String>,
    my_time: Option<String>,
    /// "Check for updates" (absent in the Microsoft Store build, where the Store updates the app).
    check_updates: Option<String>,
    /// "Pause friendly messages for 1 h" (`pause-friendly`) or "Friendly messages paused until …" (`resume-friendly`);
    /// absent with both message switches off.
    #[serde(default)]
    pause_friendly: Option<TrayMenuItem>,
    /// "Today's meetings ▸" submenu label and its items (`meeting:<16 hex>`, contract §23.4); absent from older UIs
    /// and while there is nothing to show.
    #[serde(default)]
    meetings_label: Option<String>,
    #[serde(default)]
    meetings: Vec<TrayMenuItem>,
    settings: String,
    quit: String,
}

/// Longest tray item text (task and meeting titles come from the server, up to 200 characters).
const MENU_LABEL_MAX: usize = 60;

/// A server-provided text as a tray menu item (audit GO-I5): control, bidi and zero-width characters removed, at most
/// [`MENU_LABEL_MAX`] characters (an ellipsis marks the cut), and `&` doubled so it is never a mnemonic (the menu
/// library maps `&&` to a literal `&` and escapes `_` for GTK itself).
fn menu_label(text: &str) -> String {
    let clean: String = text
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{061C}' | '\u{FEFF}')
        })
        .collect();
    let clean = clean.trim();
    let cut: String = if clean.chars().count() > MENU_LABEL_MAX {
        let mut short: String = clean.chars().take(MENU_LABEL_MAX - 1).collect();
        short.push('…');
        short
    } else {
        clean.to_string()
    };
    cut.replace('&', "&&")
}

/// A meeting of the tray's *Today* submenu: `meeting:` and the first 16 hex characters of its dedupe key (never the
/// meeting's id or title).
fn tray_meeting_id(id: &str) -> bool {
    id.strip_prefix("meeting:").is_some_and(|key| {
        key.len() == 16
            && key
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    })
}

/// Menu ids the UI may use (anything else is ignored): fixed actions, or `switch:<task id>`.
fn tray_action_allowed(id: &str) -> bool {
    matches!(
        id,
        "stop"
            | "resume"
            | "search"
            | "open-beacon"
            | "my-time"
            | "check-updates"
            | "settings"
            | "pause-friendly"
            | "resume-friendly"
            | "layout-full"
            | "layout-compact"
            | "open-chat"
            | "pause-chat"
            | "resume-chat"
    ) || (id.starts_with("switch:") && id.len() > 7 && id.len() <= 200)
        || tray_meeting_id(id)
}

/// Tray base icon: the simplified Beacon mark (the 0.1.0 app icon), 64×64 RGBA generated by `scripts/icons/build.py`.
/// The app icon (window, installers) is the mascot head; the tray keeps the simpler mark, which reads better small.
const TRAY_MARK: &[u8] = include_bytes!("../icons/tray-64.rgba");
const TRAY_MARK_SIZE: u32 = 64;

fn tray_mark() -> Image<'static> {
    Image::new(TRAY_MARK, TRAY_MARK_SIZE, TRAY_MARK_SIZE)
}

/// Icon variant: running = the app icon with a moss dot (bottom right); stopped = the app icon in grey.
fn icon_variant(base: &Image<'_>, running: bool) -> Image<'static> {
    let (width, height) = (base.width(), base.height());
    let mut rgba = base.rgba().to_vec();
    let radius = (width.min(height) as f32) * 0.22;
    let (cx, cy) = (width as f32 - radius - 1.0, height as f32 - radius - 1.0);
    for y in 0..height {
        for x in 0..width {
            let i = ((y * width + x) * 4) as usize;
            if running {
                let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
                let d = (dx * dx + dy * dy).sqrt();
                if d <= radius {
                    let rim = d > radius - (radius * 0.25).max(1.0);
                    let (r, g, b) = if rim {
                        (255, 255, 255)
                    } else {
                        (0x1f, 0x6f, 0x54)
                    };
                    rgba[i..i + 4].copy_from_slice(&[r, g, b, 255]);
                }
            } else {
                let grey =
                    (rgba[i] as u32 * 30 + rgba[i + 1] as u32 * 59 + rgba[i + 2] as u32 * 11) / 100;
                let grey = grey as u8;
                rgba[i] = grey;
                rgba[i + 1] = grey;
                rgba[i + 2] = grey;
            }
        }
    }
    Image::new_owned(rgba, width, height)
}

/// The tray icon for the timer state and the unread dot.
fn apply_tray_icon(tray: &tauri::tray::TrayIcon<Wry>, state: &TrayState) -> Result<(), String> {
    let running = *state.running_now.lock().map_err(|e| e.to_string())?;
    let unread = *state.unread.lock().map_err(|e| e.to_string())?;
    let icon = match (running, unread) {
        (true, false) => &state.running,
        (false, false) => &state.stopped,
        (true, true) => &state.running_unread,
        (false, true) => &state.stopped_unread,
    };
    if let Some(icon) = icon {
        tray.set_icon(Some(icon.clone()))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A red unread dot in the icon's top-right corner (Beacon's `--badge` colour, white rim): the tray icon with unread
/// chat messages, and the Windows taskbar overlay.
fn unread_variant(base: &Image<'_>) -> Image<'static> {
    let (width, height) = (base.width(), base.height());
    let mut rgba = base.rgba().to_vec();
    let radius = (width.min(height) as f32) * 0.2;
    let (cx, cy) = (width as f32 - radius - 1.0, radius + 1.0);
    for y in 0..height {
        for x in 0..width {
            let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
            let d = (dx * dx + dy * dy).sqrt();
            if d <= radius {
                let i = ((y * width + x) * 4) as usize;
                let rim = d > radius - (radius * 0.25).max(1.0);
                let (r, g, b) = if rim {
                    (255, 255, 255)
                } else {
                    (0xc8, 0x37, 0x2d)
                };
                rgba[i..i + 4].copy_from_slice(&[r, g, b, 255]);
            }
        }
    }
    Image::new_owned(rgba, width, height)
}

/// Clamps the unread count the UI sends to what a badge shows (`None` hides it).
fn badge_count(count: u32) -> Option<i64> {
    (count > 0).then_some(i64::from(count.min(9999)))
}

/// Chat unread badge (BD-2, design §3.4): a dot on the tray icon, the Dock badge (macOS), the launcher count (Linux,
/// Unity API where present) or a taskbar overlay dot (Windows). The count is the server's `unreadTotal` (muted
/// conversations excluded); 0 clears it. Best effort: an OS without badges ignores it.
#[tauri::command]
fn set_unread_badge(app: AppHandle, window: tauri::Window, count: u32) -> Result<(), String> {
    only_from(&window, "main")?;
    if let Some(state) = app.try_state::<TrayState>() {
        *state.unread.lock().map_err(|e| e.to_string())? = count > 0;
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            apply_tray_icon(&tray, &state)?;
        }
    }
    if let Some(main) = app.get_webview_window("main") {
        #[cfg(windows)]
        {
            let overlay = badge_count(count)
                .map(|_| unread_variant(&Image::new_owned(vec![0; 16 * 16 * 4], 16, 16)));
            let _ = main.set_overlay_icon(overlay);
        }
        #[cfg(not(windows))]
        {
            let _ = main.set_badge_count(badge_count(count));
        }
    }
    Ok(())
}

/// Defence in depth on top of the capabilities (build.rs declares every app command, each window gets only its own):
/// the privileged commands also refuse any caller but the main window.
pub(crate) fn only_from(window: &tauri::Window, label: &str) -> Result<(), String> {
    caller_allowed(window.label(), label)
}

pub(crate) fn caller_allowed(caller: &str, label: &str) -> Result<(), String> {
    if caller == label {
        Ok(())
    } else {
        Err("not allowed from this window".into())
    }
}

/// Seconds since the last keyboard / mouse input, read locally from the OS. Never sent anywhere.
/// Returns 0 when the platform cannot tell (e.g. some Wayland sessions): idle detection then never triggers.
#[tauri::command]
fn idle_seconds(window: tauri::Window) -> Result<u64, String> {
    only_from(&window, "main")?;
    Ok(read_idle_seconds())
}

/// The OS idle counter (also read by the heartbeat thread).
pub(crate) fn read_idle_seconds() -> u64 {
    user_idle::UserIdle::get_time()
        .map(|idle| idle.as_seconds())
        .unwrap_or(0)
}

/// Updates the tray tooltip, title (macOS, Linux), status line and icon variant.
#[tauri::command]
fn set_tray_status(
    app: AppHandle,
    window: tauri::Window,
    status: TrayStatus,
) -> Result<(), String> {
    only_from(&window, "main")?;
    // A running clock: its texts now, then every minute from the heartbeat (the UI's title / tooltip are the same).
    let clocked = match app.try_state::<TrayState>() {
        Some(state) => state
            .clock
            .lock()
            .map_err(|e| e.to_string())?
            .set(status.clock.clone(), heartbeat::now_ms()),
        None => None,
    };
    let (title, tooltip) = match &clocked {
        Some(text) => (Some(text.title.as_str()), text.tooltip.as_str()),
        None => (status.title.as_deref(), status.tooltip.as_str()),
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
        tray.set_title(title).map_err(|e| e.to_string())?;
        if let Some(state) = app.try_state::<TrayState>() {
            *state.running_now.lock().map_err(|e| e.to_string())? = status.running;
            apply_tray_icon(&tray, &state)?;
        }
    }
    if let Some(state) = app.try_state::<TrayState>() {
        if let Some(item) = state.status.lock().map_err(|e| e.to_string())?.as_ref() {
            item.set_text(&status.status).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Rebuilds the tray menu with the UI's translated labels and quick tasks:
/// status · Stop / Resume · Switch to ▸ · Search task… · — · Open Beacon Desktop · Full / Compact view · Open Beacon · My time · — · Pause friendly
/// messages 1 h · Check for updates… · Settings… · Quit.
#[tauri::command]
fn set_tray_menu(app: AppHandle, window: tauri::Window, menu: TrayMenuSpec) -> Result<(), String> {
    only_from(&window, "main")?;
    let err = |e: tauri::Error| e.to_string();
    let state = app.state::<TrayState>();
    let mut status_slot = state.status.lock().map_err(|e| e.to_string())?;
    let status_text = match status_slot.as_ref() {
        Some(item) => item.text().map_err(err)?,
        None => APP_DISPLAY_NAME.to_string(),
    };
    let status =
        MenuItem::with_id(&app, "status", &status_text, false, None::<&str>).map_err(err)?;
    let built = Menu::new(&app).map_err(err)?;
    built.append(&status).map_err(err)?;
    if let Some(primary) = menu.primary.filter(|item| tray_action_allowed(&item.id)) {
        let item =
            MenuItem::with_id(&app, primary.id, &primary.label, true, None::<&str>).map_err(err)?;
        built.append(&item).map_err(err)?;
    }
    let tasks: Vec<MenuItem<Wry>> = menu
        .switch_to
        .into_iter()
        .filter(|task| tray_action_allowed(&task.id))
        .take(7)
        .map(|task| MenuItem::with_id(&app, task.id, menu_label(&task.label), true, None::<&str>))
        .collect::<Result<_, _>>()
        .map_err(err)?;
    if !tasks.is_empty() {
        let refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = tasks
            .iter()
            .map(|item| item as &dyn tauri::menu::IsMenuItem<Wry>)
            .collect();
        let submenu = Submenu::with_items(&app, &menu.switch_label, true, &refs).map_err(err)?;
        built.append(&submenu).map_err(err)?;
    }
    let meetings: Vec<MenuItem<Wry>> = menu
        .meetings
        .into_iter()
        .filter(|item| tray_meeting_id(&item.id))
        .take(7)
        .map(|item| MenuItem::with_id(&app, item.id, menu_label(&item.label), true, None::<&str>))
        .collect::<Result<_, _>>()
        .map_err(err)?;
    if let (Some(label), false) = (menu.meetings_label.as_deref(), meetings.is_empty()) {
        let refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = meetings
            .iter()
            .map(|item| item as &dyn tauri::menu::IsMenuItem<Wry>)
            .collect();
        let submenu = Submenu::with_items(&app, label, true, &refs).map_err(err)?;
        built.append(&submenu).map_err(err)?;
    }
    built
        .append(&MenuItem::with_id(&app, "search", &menu.search, true, None::<&str>).map_err(err)?)
        .map_err(err)?;
    built
        .append(&PredefinedMenuItem::separator(&app).map_err(err)?)
        .map_err(err)?;
    built
        .append(&MenuItem::with_id(&app, "open", &menu.open, true, None::<&str>).map_err(err)?)
        .map_err(err)?;
    for item in menu
        .chat
        .into_iter()
        .filter(|item| matches!(item.id.as_str(), "open-chat" | "pause-chat" | "resume-chat"))
        .take(2)
    {
        built
            .append(
                &MenuItem::with_id(&app, item.id, menu_label(&item.label), true, None::<&str>)
                    .map_err(err)?,
            )
            .map_err(err)?;
    }
    if let Some(item) = menu.layout.filter(|item| tray_action_allowed(&item.id)) {
        built
            .append(
                &MenuItem::with_id(&app, item.id, &item.label, true, None::<&str>).map_err(err)?,
            )
            .map_err(err)?;
    }
    if let Some(label) = menu.open_beacon {
        built
            .append(
                &MenuItem::with_id(&app, "open-beacon", &label, true, None::<&str>).map_err(err)?,
            )
            .map_err(err)?;
    }
    if let Some(label) = menu.my_time {
        built
            .append(&MenuItem::with_id(&app, "my-time", &label, true, None::<&str>).map_err(err)?)
            .map_err(err)?;
    }
    built
        .append(&PredefinedMenuItem::separator(&app).map_err(err)?)
        .map_err(err)?;
    if let Some(item) = menu
        .pause_friendly
        .filter(|item| tray_action_allowed(&item.id))
    {
        built
            .append(
                &MenuItem::with_id(&app, item.id, &item.label, true, None::<&str>).map_err(err)?,
            )
            .map_err(err)?;
    }
    if let Some(label) = menu.check_updates {
        built
            .append(
                &MenuItem::with_id(&app, "check-updates", &label, true, None::<&str>)
                    .map_err(err)?,
            )
            .map_err(err)?;
    }
    built
        .append(
            &MenuItem::with_id(&app, "settings", &menu.settings, true, None::<&str>)
                .map_err(err)?,
        )
        .map_err(err)?;
    built
        .append(&MenuItem::with_id(&app, "quit", &menu.quit, true, None::<&str>).map_err(err)?)
        .map_err(err)?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(built)).map_err(err)?;
    }
    *status_slot = Some(status);
    Ok(())
}

/// Replaces a global shortcut: `open` (the default slot: show the window and search) or `resume` ("Continue the last
/// task", window hidden or not). On failure (in use by another app, invalid, the other slot's) the previous one is
/// registered again and the error goes back to the UI, which shows it in Settings.
#[tauri::command]
fn set_global_shortcut(
    app: AppHandle,
    window: tauri::Window,
    accelerator: String,
    slot: Option<String>,
) -> Result<(), String> {
    only_from(&window, "main")?;
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let shortcuts = app.global_shortcut();
    let state = app.state::<TrayState>();
    let resume = shortcut_slot(slot.as_deref())?;
    let (mut current, other) = if resume {
        (
            state.resume_shortcut.lock().map_err(|e| e.to_string())?,
            state.shortcut.lock().map_err(|e| e.to_string())?.clone(),
        )
    } else {
        (
            state.shortcut.lock().map_err(|e| e.to_string())?,
            state
                .resume_shortcut
                .lock()
                .map_err(|e| e.to_string())?
                .clone(),
        )
    };
    if current.as_deref() == Some(accelerator.as_str()) {
        return Ok(());
    }
    if same_shortcut(other.as_deref(), &accelerator) {
        return Err(format!(
            "{accelerator} is already used by the other shortcut"
        ));
    }
    if let Some(previous) = current.as_deref() {
        let _ = shortcuts.unregister(previous);
    }
    match shortcuts.register(accelerator.as_str()) {
        Ok(()) => {
            *current = Some(accelerator);
            Ok(())
        }
        Err(e) => {
            if let Some(previous) = current.as_deref() {
                let _ = shortcuts.register(previous);
            }
            Err(e.to_string())
        }
    }
}

/// `open` (or absent, older UIs) → false, `resume` → true; anything else is refused.
fn shortcut_slot(slot: Option<&str>) -> Result<bool, String> {
    match slot {
        None | Some(SLOT_OPEN) => Ok(false),
        Some(SLOT_RESUME) => Ok(true),
        Some(_) => Err("unknown shortcut".into()),
    }
}

/// Whether two accelerators are the same keys (`Ctrl+Alt+Space` = `control+alt+space`).
fn same_shortcut(registered: Option<&str>, accelerator: &str) -> bool {
    use tauri_plugin_global_shortcut::Shortcut;
    match (
        registered.and_then(|value| value.parse::<Shortcut>().ok()),
        accelerator.parse::<Shortcut>().ok(),
    ) {
        (Some(a), Some(b)) => a.id() == b.id(),
        _ => false,
    }
}

/// Marker committed in `tauri.conf.json` instead of the real updater public key. A build that still carries it cannot
/// verify updates: the release check (`scripts/release/check-updater-key.mjs`) refuses it, and the app treats it as "no
/// key" (manual download from Beacon, never a blocking screen). Keep in sync with the script.
const PUBKEY_PLACEHOLDER: &str = "REPLACE_WITH_TIMETRACK_UPDATER_PUBLIC_KEY";

/// Microsoft Store build (`TIMETRACK_CHANNEL=store` at compile time): the Store installs and updates the app, so the
/// in-app updater is not registered and the update commands refuse to run.
fn store_channel() -> bool {
    matches!(option_env!("TIMETRACK_CHANNEL"), Some("store"))
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum UpdateCheck {
    UpToDate {
        /// Beacon's `X-Min-Supported-Version` header (also sent on 204).
        min_supported_version: Option<String>,
    },
    Unauthorized,
    Available {
        version: String,
        notes: Option<String>,
        min_supported_version: Option<String>,
        /// False when this build cannot install it by itself (no updater public key, or installed from a package the
        /// updater does not replace: MSI, deb): the UI offers the Beacon download instead and never blocks.
        installable: bool,
    },
    /// Store build: updates come from the Microsoft Store.
    Disabled,
    Error {
        message: String,
    },
}

/// Download progress sent to the UI as `update-progress` events while an update downloads, then `installing`.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "phase", rename_all = "snake_case")]
enum UpdateProgress {
    Downloading { downloaded: u64, total: Option<u64> },
    Installing,
}

fn updater_target() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    }
}

/// How this copy was installed, in the updater's names (`{{bundle_type}}`); `unknown` for a plain binary (MSIX).
fn bundle_name(bundle: Option<tauri::utils::config::BundleType>) -> &'static str {
    use tauri::utils::config::BundleType;
    match bundle {
        Some(BundleType::AppImage) => "appimage",
        Some(BundleType::Deb) => "deb",
        Some(BundleType::Rpm) => "rpm",
        Some(BundleType::Msi) => "msi",
        Some(BundleType::Nsis) => "nsis",
        Some(BundleType::App) | Some(BundleType::Dmg) => "app",
        _ => "unknown",
    }
}

/// The updater replaces an AppImage, an NSIS install or a macOS `.app` with Beacon's single updater file per OS and
/// CPU (AppImage, NSIS `-setup.exe`, `.app.tar.gz`). An MSI or deb install would get the wrong package: those users
/// are offered the Beacon download (docs/RELEASE-PLAN-0.4.0.md, "Windows installers").
fn bundle_self_updates(name: &str) -> bool {
    matches!(name, "appimage" | "nsis" | "app")
}

/// Beacon's route `time_track_client_updater`. `bundle_type` is a query parameter Beacon may use to pick the file (it
/// ignores unknown parameters today); the Tauri updater fills the `{{…}}` placeholders.
fn updater_endpoint(server: &str) -> String {
    format!(
        "{}/api/time-track/updates/desktop/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}?bundle_type={{{{bundle_type}}}}",
        server.trim_end_matches('/')
    )
}

/// The server the user signed in to must be https (or, in debug builds, loopback http) without userinfo; validated
/// again in Rust because `server` comes from the webview. Same rule as `beacon_fetch` (net.rs).
fn validate_server(server: &str) -> Result<url::Url, String> {
    net::validate_url(server).map_err(|_| "invalid server URL".to_string())
}

/// The updater commands talk to the bound server only (net.rs, FY-L1): `server` comes from the webview.
fn bound_server(session: &secret::Session, server: &str) -> Result<url::Url, String> {
    let url = validate_server(server)?;
    net::require_origin(session.bound_origin().as_ref(), &url)?;
    Ok(url)
}

/// The updater copies the builder headers to the artifact download (plugin 2.14.1, updater.rs L836–864).
/// The artifact URL is a pre-signed object-storage URL: the token never leaves Beacon's origin.
fn strip_token_for_download(
    server: &url::Url,
    download: &url::Url,
    headers: &mut reqwest::header::HeaderMap,
) {
    if server.origin() != download.origin() {
        headers.remove(AUTHORIZATION);
    }
}

/// A minisign public key as written by `tauri signer generate` (`.key.pub`, base64). The placeholder, an empty value
/// or anything that is not base64 is "no key". The release check decodes it fully.
fn usable_pubkey(candidate: Option<&str>) -> Option<String> {
    let key = candidate?.trim();
    let base64 = key
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='));
    (key.len() >= 40 && key != PUBKEY_PLACEHOLDER && base64).then(|| key.to_string())
}

/// The updater public key of this build: `TAURI_UPDATER_PUBKEY` at compile time, else `plugins.updater.pubkey` of
/// tauri.conf.json. Only the public key is ever in the repository or the binary.
fn updater_pubkey(app: &AppHandle) -> Option<String> {
    usable_pubkey(option_env!("TAURI_UPDATER_PUBKEY")).or_else(|| {
        usable_pubkey(
            app.config()
                .plugins
                .0
                .get("updater")
                .and_then(|updater| updater.get("pubkey"))
                .and_then(|key| key.as_str()),
        )
    })
}

fn parse_update(body: &str, header_min: Option<String>, installable: bool) -> UpdateCheck {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(json) => UpdateCheck::Available {
            version: json["version"].as_str().unwrap_or_default().to_string(),
            notes: json["notes"].as_str().map(str::to_string),
            min_supported_version: json["min_supported_version"]
                .as_str()
                .map(str::to_string)
                .or(header_min),
            installable,
        },
        Err(e) => UpdateCheck::Error {
            message: e.to_string(),
        },
    }
}

/// Beacon's updater route (`time_track_client_updater`). 204 = up to date, 401 = sign in again (not an error),
/// 200 = `{version, notes, pub_date, url, signature, min_supported_version?}` (Tauri v2 dynamic-server format).
#[tauri::command]
async fn check_update(app: AppHandle, window: tauri::Window, server: String) -> UpdateCheck {
    if let Err(message) = only_from(&window, "main") {
        return UpdateCheck::Error { message };
    }
    if store_channel() {
        return UpdateCheck::Disabled;
    }
    // `State` borrows the request: an async command returning a plain value takes the state from the app handle.
    let session = std::sync::Arc::clone(&app.state::<std::sync::Arc<secret::Session>>());
    let server_url = match bound_server(&session, &server) {
        Ok(url) => url,
        Err(message) => return UpdateCheck::Error { message },
    };
    // The token never crosses to the webview: Rust reads it here, for its own origin only, off the async workers
    // (secret.rs).
    let target = server_url.clone();
    let authorization =
        match secret::blocking(move || session_authorization(&session, &target)).await {
            Ok(Some(value)) => value,
            Ok(None) => return UpdateCheck::Unauthorized,
            Err(message) => return UpdateCheck::Error { message },
        };
    let bundle = bundle_name(tauri::utils::platform::bundle_type());
    let url = updater_endpoint(&server)
        .replace("{{target}}", updater_target())
        .replace("{{arch}}", std::env::consts::ARCH)
        .replace(
            "{{current_version}}",
            &app.package_info().version.to_string(),
        )
        .replace("{{bundle_type}}", bundle);
    // Pinned TLS on the official host (net.rs): the Bearer token never goes through an inspecting proxy.
    let response = match net::client()
        .get(&url)
        .header(AUTHORIZATION, authorization)
        .send()
        .await
    {
        Ok(response) => response,
        Err(e) => {
            return UpdateCheck::Error {
                message: net::describe_error(e),
            }
        }
    };
    let header_min = response
        .headers()
        .get("x-min-supported-version")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    match response.status().as_u16() {
        204 => UpdateCheck::UpToDate {
            min_supported_version: header_min,
        },
        401 => UpdateCheck::Unauthorized,
        200 => match response.text().await {
            Ok(body) => parse_update(
                &body,
                header_min,
                updater_pubkey(&app).is_some() && bundle_self_updates(bundle),
            ),
            Err(e) => UpdateCheck::Error {
                message: net::describe_error(e),
            },
        },
        status => UpdateCheck::Error {
            message: format!("HTTP {status}"),
        },
    }
}

/// The `Authorization` value of the stored session for `server` (`None`: signed out, or the token belongs to another
/// origin). Errors never quote the token.
fn session_authorization(
    session: &secret::Session,
    server: &url::Url,
) -> Result<Option<reqwest::header::HeaderValue>, String> {
    Ok(match session.authorization_for(server)? {
        secret::Authorization::Bearer(value) => Some(value),
        secret::Authorization::None => None,
    })
}

/// Turns the updater's chunk callbacks into at most ~100 `update-progress` events (one per percent, or per MiB when
/// the size is unknown).
struct ProgressThrottle {
    downloaded: u64,
    last_step: Option<u64>,
}

impl ProgressThrottle {
    fn new() -> Self {
        Self {
            downloaded: 0,
            last_step: None,
        }
    }

    fn chunk(&mut self, length: usize, total: Option<u64>) -> Option<UpdateProgress> {
        self.downloaded += length as u64;
        let step = match total {
            Some(total) if total > 0 => self.downloaded.min(total) * 100 / total,
            _ => self.downloaded / (1024 * 1024),
        };
        if self.last_step == Some(step) {
            return None;
        }
        self.last_step = Some(step);
        Some(UpdateProgress::Downloading {
            downloaded: self.downloaded,
            total,
        })
    }
}

/// Downloads, verifies (minisign public key of the build, signed version) and installs the update, then restarts.
/// The Bearer token is set at runtime through the updater builder headers and removed for the artifact download.
#[tauri::command]
async fn install_update(
    app: AppHandle,
    window: tauri::Window,
    session: tauri::State<'_, std::sync::Arc<secret::Session>>,
    server: String,
) -> Result<(), String> {
    only_from(&window, "main")?;
    if store_channel() {
        return Err("Updates come from the Microsoft Store.".into());
    }
    let server_url = bound_server(&session, &server)?;
    let (owner, target) = (std::sync::Arc::clone(&session), server_url.clone());
    let authorization = secret::blocking(move || session_authorization(&owner, &target))
        .await?
        .ok_or_else(|| "Not connected.".to_string())?;
    let Some(pubkey) = updater_pubkey(&app) else {
        return Err("This build cannot verify updates (no updater key).".into());
    };
    let endpoint = url::Url::parse(&updater_endpoint(&server)).map_err(|e| e.to_string())?;
    let update = app
        .updater_builder()
        .pubkey(pubkey)
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .header(AUTHORIZATION, authorization)
        .map_err(|e| e.to_string())?
        // Same pinned TLS as the API (net.rs): the update check carries the Bearer token. The artifact itself is
        // also verified with the minisign key of the build.
        .configure_client(|client| {
            client.tls_backend_preconfigured(pinning::shipped_client_config())
        })
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| net::error_text(&e))?;
    // Gone since the check (rolled back, or another copy already updated): the UI shows the Beacon download.
    let Some(mut update) = update else {
        return Err("This update is no longer offered.".into());
    };
    let download = update.download_url.clone();
    strip_token_for_download(&server_url, &download, &mut update.headers);
    let mut throttle = ProgressThrottle::new();
    let progress = app.clone();
    let finished = app.clone();
    update
        .download_and_install(
            move |length, total| {
                if let Some(event) = throttle.chunk(length, total) {
                    let _ = progress.emit("update-progress", event);
                }
            },
            move || {
                let _ = finished.emit("update-progress", UpdateProgress::Installing);
            },
        )
        .await
        .map_err(|e| net::error_text(&e))?;
    app.restart()
}

pub(crate) fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// When the main window last lost the focus. A click on the tray icon takes the focus from the window first (Windows),
/// so "the window was focused a moment ago" counts as focused.
#[derive(Default)]
struct MainFocus {
    blurred_at: Mutex<Option<Instant>>,
}

const RECENT_FOCUS: Duration = Duration::from_millis(600);

/// Left click on the tray icon: hide a window the person is looking at, otherwise bring it forward.
fn tray_click_hides(
    visible: bool,
    minimized: bool,
    focused: bool,
    blurred_ago: Option<Duration>,
) -> bool {
    visible && !minimized && (focused || blurred_ago.is_some_and(|ago| ago < RECENT_FOCUS))
}

fn toggle_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let blurred_ago = app
        .try_state::<MainFocus>()
        .and_then(|state| state.blurred_at.lock().ok().and_then(|at| *at))
        .map(|at| at.elapsed());
    let hide = tray_click_hides(
        window.is_visible().unwrap_or(false),
        window.is_minimized().unwrap_or(false),
        window.is_focused().unwrap_or(false),
        blurred_ago,
    );
    if hide {
        let _ = window.hide();
    } else {
        show_main(app);
    }
}

/// Heartbeat state shared by the thread and `set_wake_plan`.
struct HeartbeatState(Mutex<heartbeat::Heartbeat>);

/// What the UI wants to be woken for besides the 30 s tick: the end of the countdown, the idle threshold.
#[tauri::command]
fn set_wake_plan(
    app: AppHandle,
    window: tauri::Window,
    plan: heartbeat::WakePlan,
) -> Result<(), String> {
    only_from(&window, "main")?;
    app.state::<HeartbeatState>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .set_plan(plan);
    Ok(())
}

/// Polls the wall clock every second and wakes the main window (`wake` events) on time, hidden or not. It also keeps
/// the tray's elapsed time current (once a minute, when its text changes) and, with meeting detection on, sends the
/// main window what holds the microphone (`mic` events, every 15–30 s).
fn spawn_heartbeat(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("heartbeat".into())
        .spawn(move || {
            let mut microphone = meeting::system_detector();
            loop {
                std::thread::sleep(Duration::from_millis(heartbeat::POLL_MS));
                let now = heartbeat::now_ms();
                let (wake, mic) = match app.state::<HeartbeatState>().0.lock() {
                    Ok(mut beat) => (beat.poll(now, read_idle_seconds), beat.mic_due(now)),
                    Err(_) => (None, false),
                };
                if let Some(wake) = wake {
                    let _ = app.emit_to("main", "wake", wake);
                }
                let text = app.try_state::<TrayState>().and_then(|state| {
                    state
                        .clock
                        .lock()
                        .ok()
                        .and_then(|mut clock| clock.poll(now))
                });
                if let (Some(text), Some(tray)) = (text, app.tray_by_id(TRAY_ID)) {
                    let _ = tray.set_tooltip(Some(&text.tooltip));
                    let _ = tray.set_title(Some(&text.title));
                }
                // Outside the lock: the probe may take a few milliseconds (a `pactl` run on Linux).
                if mic {
                    let _ = app.emit_to("main", "mic", meeting::snapshot(microphone.probe(), now));
                }
            }
        });
}

/// A friendly message as a native notification (see notify.rs). An error makes the UI show it inside the app.
#[tauri::command]
fn notify_friendly(
    app: AppHandle,
    window: tauri::Window,
    note: notify::FriendlyNote,
) -> Result<(), String> {
    only_from(&window, "main")?;
    notify::show(&app, &note)
}

/// "Start at login" on or off (Settings). Windows: our own HKCU-only write with the path quoted (autostart.rs
/// `toggle_plan`), never the plugin's unquoted / HKLM one; macOS and Linux: the autostart plugin (LaunchAgent, XDG).
#[tauri::command]
fn set_autostart(app: AppHandle, window: tauri::Window, enabled: bool) -> Result<(), String> {
    only_from(&window, "main")?;
    #[cfg(windows)]
    {
        autostart::set(&app.package_info().name, &[HIDDEN_ARG], enabled)
    }
    #[cfg(not(windows))]
    {
        use tauri_plugin_autostart::ManagerExt;
        let launcher = app.autolaunch();
        if enabled {
            launcher.enable()
        } else {
            launcher.disable()
        }
        .map_err(|e| e.to_string())
    }
}

/// "Start at login" as Settings shows it. Windows: only the app's own HKCU value and its Task Manager state
/// (autostart.rs `status`), not the plugin's `is_enabled` (which also counts HKLM); macOS and Linux: the plugin.
#[tauri::command]
fn get_autostart(app: AppHandle, window: tauri::Window) -> Result<bool, String> {
    only_from(&window, "main")?;
    #[cfg(windows)]
    {
        Ok(autostart::get(&app.package_info().name))
    }
    #[cfg(not(windows))]
    {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch().is_enabled().map_err(|e| e.to_string())
    }
}

/// Another launch of the app (Start menu, desktop shortcut, a second start-at-login entry) while this one runs: it
/// exits and this one shows its window, unless it was a start at login (`--hidden`), which stays in the tray.
fn on_second_launch(app: &AppHandle, args: &[String]) {
    if second_launch_shows_window(args) {
        show_main(app);
    }
}

fn second_launch_shows_window(args: &[String]) -> bool {
    !args.iter().skip(1).any(|arg| arg == HIDDEN_ARG)
}

/// Builds the tray icon once: a second call (it is only called from `setup`) keeps the existing icon.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() || app.try_state::<TrayState>().is_some() {
        return Ok(());
    }
    // Minimal untranslated menu until the UI sends the translated one (`set_tray_menu`).
    let status = MenuItem::with_id(app, "status", APP_DISPLAY_NAME, false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Beacon Desktop", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &open, &quit])?;
    let base = Some(tray_mark());
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(APP_DISPLAY_NAME)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id.as_ref();
            match id {
                "open" => show_main(app),
                "quit" => app.exit(0),
                _ if tray_action_allowed(id) => {
                    // A meeting of *Today* opens the window too (its *Join* button and the list are there).
                    if matches!(
                        id,
                        "search"
                            | "settings"
                            | "check-updates"
                            | "layout-full"
                            | "layout-compact"
                            | "open-chat"
                    ) || tray_meeting_id(id)
                    {
                        show_main(app);
                    }
                    let _ = app.emit("tray-action", id.to_string());
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main(tray.app_handle());
            }
        });
    let (running, stopped) = match &base {
        Some(icon) => (
            Some(icon_variant(icon, true)),
            Some(icon_variant(icon, false)),
        ),
        None => (None, None),
    };
    let running_unread = running.as_ref().map(unread_variant);
    let stopped_unread = stopped.as_ref().map(unread_variant);
    if let Some(icon) = stopped.clone().or(base) {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    app.manage(TrayState {
        status: Mutex::new(Some(status)),
        running,
        stopped,
        shortcut: Mutex::new(None),
        resume_shortcut: Mutex::new(None),
        clock: Mutex::new(tray_clock::TrayClock::new()),
        unread: Mutex::new(false),
        running_unread,
        stopped_unread,
        running_now: Mutex::new(false),
    });
    Ok(())
}

/// Whether a navigation stays inside the app (its own pages; the Vite dev server in debug builds).
pub(crate) fn internal_navigation(url: &url::Url) -> bool {
    match url.scheme() {
        "tauri" | "about" => true,
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || (cfg!(debug_assertions)
                    && url.host_str() == Some("localhost")
                    && url.port() == Some(1420))
        }
        _ => false,
    }
}

/// The main window (tauri.conf.json, `create: false`), built here so that no link ever opens inside the app or in a
/// browser the person did not choose: a navigation away from the app or a new window (`target=_blank`,
/// `window.open`) is refused and its https URL is handed to the UI (`open-external`), which opens it through
/// `open_external` with the "Open Beacon in" setting.
fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
    else {
        return Ok(());
    };
    let to_ui = app.clone();
    let to_ui_new = app.clone();
    tauri::WebviewWindowBuilder::from_config(app, &config)?
        .on_navigation(move |url| {
            if internal_navigation(url) {
                return true;
            }
            if url.scheme() == "https" {
                let _ = to_ui.emit_to("main", "open-external", url.as_str());
            }
            false
        })
        .on_new_window(move |url, _features| {
            if url.scheme() == "https" {
                let _ = to_ui_new.emit_to("main", "open-external", url.as_str());
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    // First plugin, so that a second launch exits before anything else starts (another tray icon, shortcuts, the
    // heartbeat): it hands its arguments to the running app (`on_second_launch`) and exits. Windows: a named mutex per
    // session; macOS: a socket; Linux: a D-Bus name (no session bus: the app starts normally, unguarded).
    let builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            on_second_launch(app, &args)
        }));
    // The Store build has no updater configuration (tauri.store.conf.json removes it) and never self-updates.
    let builder = if store_channel() {
        builder
    } else {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    };
    builder
        // `beacon-desktop://` links (deeplink.rs); after the single instance, which forwards them to this app.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        // Registered but never enabled by default: the user opts in from Settings.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN_ARG]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let resume = app.try_state::<TrayState>().and_then(|state| {
                        state.resume_shortcut.lock().ok().and_then(|s| s.clone())
                    });
                    let pressed = shortcut.id();
                    let is_resume = resume
                        .and_then(|value| {
                            value.parse::<tauri_plugin_global_shortcut::Shortcut>().ok()
                        })
                        .is_some_and(|registered| registered.id() == pressed);
                    if is_resume {
                        // "Continue the last task": the window stays as it is (hidden in the tray, or behind).
                        let _ = app.emit_to("main", "shortcut-resume", ());
                    } else {
                        show_main(app);
                        let _ = app.emit("shortcut", ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Duplicate or stale start-at-login entries (0.1.0 MSI copy, HKLM) start a second copy: keep one, for
            // this installed executable (autostart.rs), first, before the window and the tray. Not in dev builds nor
            // in the Store build.
            #[cfg(windows)]
            if !cfg!(debug_assertions) && !store_channel() {
                autostart::apply(&app.package_info().name, &[HIDDEN_ARG]);
            }
            app.manage(HeartbeatState(Mutex::new(heartbeat::Heartbeat::new())));
            app.manage(MainFocus::default());
            app.manage(prompt::PromptState::default());
            app.manage(mini::MiniState::default());
            app.manage(deeplink::Pending::default());
            // The pause after a declined sign-in survives a restart (audit GO-I2).
            // Time token (`session-token`), chat token (`chat-token`, BD-2) and tasks token (`tasks-token`, BD-3b):
            // three entries of the same service.
            let session = secret::Session::new(Box::new(secret::Keychain::time()))
                .with_chat_store(Box::new(secret::Keychain::chat()))
                .with_tasks_store(Box::new(secret::Keychain::tasks()));
            let session = match app.path().app_data_dir() {
                Ok(dir) => session.with_declines_file(dir.join("sign-in-pause.json")),
                Err(_) => session,
            };
            app.manage(std::sync::Arc::new(session));
            // Chat realtime stream (realtime.rs): one per app, restarted on context changes.
            app.manage(std::sync::Arc::new(realtime::Realtime::new()));
            // "Open Beacon in" lives on this side (browser.json in the app's config folder), see browser.rs.
            browser::manage(app.handle());
            create_main_window(app.handle())?;
            build_tray(app)?;
            spawn_heartbeat(app.handle().clone());
            // Screen lock / sleep events for "Pause on lock or sleep" (the UI decides whether to use them).
            session::start(app.handle());
            // `beacon-desktop://` links: the one the app was started with, and every later one.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // AppImage / dev builds: register the scheme at run time (installers register it themselves).
                #[cfg(any(windows, target_os = "linux"))]
                let _ = app.deep_link().register_all();
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        deeplink::open(app.handle(), url.as_str());
                    }
                }
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        deeplink::open(&handle, url.as_str());
                    }
                });
            }
            // Started at login (opt-in autostart passes --hidden): stay in the tray.
            if std::env::args().any(|arg| arg == HIDDEN_ARG) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            // The UI registers the configured shortcut at start (`set_global_shortcut`); this default covers the
            // time before the webview loads. A refusal is shown in Settings by the UI.
            if app.global_shortcut().register(DEFAULT_SHORTCUT).is_ok() {
                *app.state::<TrayState>()
                    .shortcut
                    .lock()
                    .expect("shortcut lock") = Some(DEFAULT_SHORTCUT.to_string());
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing (or minimising) the main window keeps the app in the tray: the timer, the idle check and the
            // friendly messages go on (heartbeat thread). "Quit" is in the tray menu.
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                let _ = window.hide();
            }
            // The "Still there?" window needs an answer: closing it is refused (the main window closes it).
            WindowEvent::CloseRequested { api, .. } if window.label() == prompt::LABEL => {
                api.prevent_close();
                let _ = window.set_focus();
            }
            // The mini timer was closed with its own button: the main window updates its toggle (BD-3a).
            WindowEvent::Destroyed if window.label() == mini::LABEL => {
                mini::closed(window.app_handle());
            }
            WindowEvent::Focused(focused) if window.label() == "main" => {
                if let Some(state) = window.app_handle().try_state::<MainFocus>() {
                    if let Ok(mut at) = state.blurred_at.lock() {
                        *at = (!focused).then(Instant::now);
                    }
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            secret::secret_status,
            secret::sign_in_begin,
            secret::secret_delete,
            secret::chat_status,
            secret::chat_connect_begin,
            secret::chat_disconnect,
            secret::tasks_status,
            secret::tasks_connect_begin,
            secret::tasks_disconnect,
            deeplink::deep_link_take,
            realtime::chat_realtime_start,
            realtime::chat_realtime_stop,
            set_unread_badge,
            idle_seconds,
            set_tray_status,
            set_tray_menu,
            set_global_shortcut,
            check_update,
            install_update,
            net::beacon_fetch,
            net::beacon_bind,
            net::connection_security,
            set_wake_plan,
            notify_friendly,
            prompt::prompt_open,
            prompt::prompt_view,
            prompt::prompt_answer,
            prompt::prompt_focus,
            prompt::prompt_close,
            prompt::prompt_show_main,
            mini::mini_open,
            mini::mini_update,
            mini::mini_close,
            mini::mini_view,
            mini::mini_action,
            browser::open_external,
            browser::open_chat_link,
            browser::list_browsers,
            browser::get_browser,
            browser::set_browser,
            browser::pick_browser,
            set_autostart,
            get_autostart
        ])
        .run(tauri::generate_context!())
        .expect("error while running Beacon Desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    mod app_commands {
        include!("../app-commands.rs");
    }
    use app_commands::{APP_COMMANDS, MAIN_COMMANDS, MINI_COMMANDS, PROMPT_COMMANDS};

    fn granted(capability: &str) -> Vec<String> {
        let json: serde_json::Value = serde_json::from_str(capability).unwrap();
        json["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str().map(str::to_string))
            .collect()
    }

    #[test]
    fn every_app_command_is_declared_and_granted_to_exactly_one_window() {
        let main = granted(include_str!("../capabilities/default.json"));
        let prompt = granted(include_str!("../capabilities/prompt.json"));
        let mini = granted(include_str!("../capabilities/mini.json"));
        let allow = |command: &str| format!("allow-{}", command.replace('_', "-"));
        for command in MAIN_COMMANDS {
            assert!(main.contains(&allow(command)), "{command} for main");
            assert!(
                !prompt.contains(&allow(command)),
                "{command} not for prompt"
            );
            assert!(!mini.contains(&allow(command)), "{command} not for mini");
        }
        for command in PROMPT_COMMANDS {
            assert!(prompt.contains(&allow(command)), "{command} for prompt");
            assert!(!main.contains(&allow(command)), "{command} not for main");
            assert!(!mini.contains(&allow(command)), "{command} not for mini");
        }
        for command in MINI_COMMANDS {
            assert!(mini.contains(&allow(command)), "{command} for mini");
            assert!(!main.contains(&allow(command)), "{command} not for main");
            assert!(
                !prompt.contains(&allow(command)),
                "{command} not for prompt"
            );
        }
        // The prompt and mini windows get nothing else but listening to their content.
        assert_eq!(prompt.len(), PROMPT_COMMANDS.len() + 2);
        assert_eq!(mini.len(), MINI_COMMANDS.len() + 2);
        assert!(mini
            .iter()
            .all(|p| p.starts_with("allow-mini-") || p.starts_with("core:event:allow-")));
        let mut both: Vec<&str> = MAIN_COMMANDS
            .iter()
            .chain(PROMPT_COMMANDS)
            .chain(MINI_COMMANDS)
            .copied()
            .collect();
        both.sort();
        let mut declared = APP_COMMANDS.to_vec();
        declared.sort();
        assert_eq!(both, declared);
        // The same list as `generate_handler!`.
        let source = include_str!("lib.rs");
        let start = source.find("generate_handler![").unwrap();
        let end = start + source[start..].find(']').unwrap();
        let mut registered: Vec<&str> = source[start + 18..end]
            .split(',')
            .map(|name| name.trim().rsplit("::").next().unwrap_or_default())
            .filter(|name| !name.is_empty())
            .collect();
        registered.sort();
        assert_eq!(registered, declared);
    }

    #[test]
    fn only_app_pages_load_in_the_window() {
        let parse = |u: &str| url::Url::parse(u).unwrap();
        assert!(internal_navigation(&parse("tauri://localhost/index.html")));
        assert!(internal_navigation(&parse(
            "http://tauri.localhost/index.html"
        )));
        assert!(internal_navigation(&parse("about:blank")));
        assert_eq!(
            internal_navigation(&parse("http://localhost:1420/")),
            cfg!(debug_assertions)
        );
        for external in [
            "https://beacon.example.com/",
            "https://www.google.com/chrome/",
            "http://localhost:8000/",
            "file:///etc/passwd",
            "data:text/html,x",
        ] {
            assert!(!internal_navigation(&parse(external)), "{external}");
        }
    }

    #[test]
    fn a_second_launch_shows_the_window_unless_it_is_a_start_at_login() {
        let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert!(second_launch_shows_window(&args(&["TimeTrack.exe"])));
        assert!(second_launch_shows_window(&args(&[])));
        assert!(!second_launch_shows_window(&args(&[
            "TimeTrack.exe",
            "--hidden"
        ])));
        // The executable path itself is never taken for the flag.
        assert!(second_launch_shows_window(&args(&["--hidden"])));
    }

    /// One tray icon per process: built in one place, guarded, and the webview cannot create another one.
    #[test]
    fn the_tray_icon_is_created_once() {
        let source = include_str!("lib.rs");
        let builder = ["TrayIcon", "Builder::"].concat();
        assert_eq!(source.matches(&builder).count(), 1, "one tray builder");
        let calls = ["build_tray", "(app)?"].concat();
        assert_eq!(source.matches(&calls).count(), 1, "built from setup only");
        let guard = [
            "if app.tray_by_id(TRAY_ID).is_some()",
            " || app.try_state::<TrayState>().is_some()",
        ]
        .concat();
        assert!(source.contains(&guard));
        for capability in [
            include_str!("../capabilities/default.json"),
            include_str!("../capabilities/prompt.json"),
        ] {
            for permission in granted(capability) {
                // `core:default` includes `core:tray:default`, which allows `new`.
                assert!(
                    permission != "core:default" && !permission.starts_with("core:tray"),
                    "{permission}"
                );
            }
        }
    }

    /// The single-instance plugin comes first, before any plugin that could start something.
    #[test]
    fn single_instance_is_the_first_plugin() {
        let source = include_str!("lib.rs");
        let run = source.find("pub fn run()").unwrap();
        let first = run + source[run..].find(".plugin(").unwrap();
        assert!(source[first..].starts_with(".plugin(tauri_plugin_single_instance::init("));
    }

    #[test]
    fn main_window_is_built_by_the_app() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = &config["app"]["windows"][0];
        assert_eq!(main["label"], "main");
        assert_eq!(main["create"], false);
    }

    #[test]
    fn privileged_commands_refuse_other_windows() {
        assert!(caller_allowed("main", "main").is_ok());
        assert!(caller_allowed("prompt", "main").is_err());
        assert!(caller_allowed("main", prompt::LABEL).is_err());
        assert!(caller_allowed(prompt::LABEL, prompt::LABEL).is_ok());
    }

    #[test]
    fn endpoint_keeps_tauri_placeholders() {
        assert_eq!(
            updater_endpoint("https://beacon.example.com/"),
            "https://beacon.example.com/api/time-track/updates/desktop/{{target}}/{{arch}}/{{current_version}}?bundle_type={{bundle_type}}"
        );
        // The placeholders survive URL parsing (path ones are percent-encoded, which the updater also replaces).
        let parsed = url::Url::parse(&updater_endpoint("https://beacon.example.com")).unwrap();
        assert_eq!(parsed.query(), Some("bundle_type={{bundle_type}}"));
    }

    #[test]
    fn tray_actions_are_allow_listed() {
        for id in [
            "stop",
            "resume",
            "search",
            "open-beacon",
            "my-time",
            "check-updates",
            "settings",
            "pause-friendly",
            "resume-friendly",
            "layout-full",
            "layout-compact",
            "open-chat",
            "pause-chat",
            "resume-chat",
            "switch:T-1",
            "meeting:0123456789abcdef",
        ] {
            assert!(tray_action_allowed(id), "{id}");
        }
        for id in [
            "quit",
            "open",
            "status",
            "switch:",
            "eval",
            "",
            "meeting:",
            "meeting:0123456789ABCDEF",
            "meeting:0123456789abcde",
            "meeting:0123456789abcdef0",
            "meeting:mtg_3f9c0d4e7a1b2c5d",
        ] {
            assert!(!tray_action_allowed(id), "{id}");
        }
    }

    #[test]
    fn icon_variants_keep_size_and_mark_state() {
        let base = Image::new_owned(vec![200; 32 * 32 * 4], 32, 32);
        let running = icon_variant(&base, true);
        let stopped = icon_variant(&base, false);
        assert_eq!((running.width(), running.height()), (32, 32));
        let dot = (24 * 32 + 24) * 4;
        assert_eq!(&running.rgba()[dot..dot + 3], &[0x1f, 0x6f, 0x54]);
        assert_eq!(&running.rgba()[0..4], &[200, 200, 200, 200]);
        assert_eq!(&stopped.rgba()[0..4], &[200, 200, 200, 200]);
    }

    #[test]
    fn unread_variant_paints_a_red_dot_top_right_and_badges_clamp() {
        let base = Image::new_owned(vec![200; 32 * 32 * 4], 32, 32);
        let dotted = unread_variant(&base);
        assert_eq!((dotted.width(), dotted.height()), (32, 32));
        let dot = (6 * 32 + 25) * 4;
        assert_eq!(&dotted.rgba()[dot..dot + 3], &[0xc8, 0x37, 0x2d]);
        let corner = (31 * 32) * 4;
        assert_eq!(&dotted.rgba()[corner..corner + 4], &[200, 200, 200, 200]);
        assert_eq!(badge_count(0), None);
        assert_eq!(badge_count(3), Some(3));
        assert_eq!(badge_count(u32::MAX), Some(9999));
    }

    #[test]
    fn tray_mark_is_a_64px_rgba_image() {
        assert_eq!(
            TRAY_MARK.len(),
            (TRAY_MARK_SIZE * TRAY_MARK_SIZE * 4) as usize
        );
        let mark = tray_mark();
        assert_eq!((mark.width(), mark.height()), (64, 64));
        assert!(mark.rgba().chunks(4).any(|pixel| pixel[3] > 0));
    }

    #[test]
    fn tray_menu_spec_deserialises_from_the_ui() {
        let spec: TrayMenuSpec = serde_json::from_str(
            r#"{"primary":{"id":"stop","label":"Stop timer"},"switchLabel":"Switch to","switchTo":[{"id":"switch:T-1","label":"A"}],"search":"Search task…","open":"Open Beacon Desktop","openBeacon":null,"myTime":"My time","checkUpdates":"Check for updates…","settings":"Settings…","quit":"Quit"}"#,
        )
        .expect("spec");
        assert_eq!(spec.switch_to.len(), 1);
        assert!(spec.open_beacon.is_none());
        assert_eq!(spec.my_time.as_deref(), Some("My time"));
        assert_eq!(spec.check_updates.as_deref(), Some("Check for updates…"));
        // The Store build sends no "Check for updates" item.
        let store: TrayMenuSpec = serde_json::from_str(
            r#"{"primary":null,"switchLabel":"Switch to","switchTo":[],"search":"s","open":"o","openBeacon":null,"myTime":null,"checkUpdates":null,"settings":"s","quit":"q"}"#,
        )
        .expect("store spec");
        assert!(store.check_updates.is_none());
    }

    #[test]
    fn tray_labels_are_capped_cleaned_and_never_mnemonics() {
        assert_eq!(menu_label("10:00 R&D sync"), "10:00 R&&D sync");
        assert_eq!(menu_label("snake_case_title"), "snake_case_title");
        assert_eq!(
            menu_label("\u{200F}10:00\u{202E} Review\u{200E}\u{2066}x\u{2069}\n"),
            "10:00 Reviewx"
        );
        let long = "a".repeat(200);
        let label = menu_label(&long);
        assert_eq!(label.chars().count(), MENU_LABEL_MAX);
        assert!(label.ends_with('…'));
        // The cap counts characters, not bytes.
        assert_eq!(menu_label(&"é".repeat(80)).chars().count(), MENU_LABEL_MAX);
    }

    #[test]
    fn tray_menu_spec_accepts_todays_meetings_and_older_uis_without_them() {
        let spec: TrayMenuSpec = serde_json::from_str(
            r#"{"primary":null,"switchLabel":"s","switchTo":[],"search":"s","open":"o","openBeacon":null,"myTime":null,"checkUpdates":null,"meetingsLabel":"Today's meetings","meetings":[{"id":"meeting:0123456789abcdef","label":"10:00 Sprint review"}],"settings":"s","quit":"q"}"#,
        )
        .unwrap();
        assert_eq!(spec.meetings_label.as_deref(), Some("Today's meetings"));
        assert_eq!(spec.meetings.len(), 1);
        assert!(tray_action_allowed(&spec.meetings[0].id));
        let old: TrayMenuSpec = serde_json::from_str(
            r#"{"primary":null,"switchLabel":"s","switchTo":[],"search":"s","open":"o","openBeacon":null,"myTime":null,"checkUpdates":null,"settings":"s","quit":"q"}"#,
        )
        .unwrap();
        assert!(old.meetings_label.is_none() && old.meetings.is_empty());
    }

    #[test]
    fn tray_menu_spec_accepts_the_pause_item_and_older_uis_without_it() {
        let spec: TrayMenuSpec = serde_json::from_str(
            r#"{"primary":null,"switchLabel":"s","switchTo":[],"search":"s","open":"o","openBeacon":null,"myTime":null,"checkUpdates":null,"pauseFriendly":{"id":"pause-friendly","label":"Pause friendly messages for 1 h"},"settings":"s","quit":"q"}"#,
        )
        .expect("spec");
        assert_eq!(
            spec.pause_friendly.map(|item| item.id).as_deref(),
            Some("pause-friendly")
        );
        let old: TrayMenuSpec = serde_json::from_str(
            r#"{"primary":null,"switchLabel":"s","switchTo":[],"search":"s","open":"o","openBeacon":null,"myTime":null,"checkUpdates":null,"settings":"s","quit":"q"}"#,
        )
        .expect("old spec");
        assert!(old.pause_friendly.is_none());
        assert!(old.chat.is_empty());
        assert!(old.layout.is_none());
        let layout: TrayMenuSpec = serde_json::from_str(
            r#"{"primary":null,"switchLabel":"s","switchTo":[],"search":"s","open":"o","layout":{"id":"layout-full","label":"Full view"},"openBeacon":null,"myTime":null,"checkUpdates":null,"settings":"s","quit":"q"}"#,
        )
        .expect("layout spec");
        assert_eq!(
            layout.layout.map(|item| item.id).as_deref(),
            Some("layout-full")
        );
    }

    #[test]
    fn shortcut_slots_and_duplicates() {
        assert_eq!(shortcut_slot(None), Ok(false));
        assert_eq!(shortcut_slot(Some("open")), Ok(false));
        assert_eq!(shortcut_slot(Some("resume")), Ok(true));
        assert!(shortcut_slot(Some("quit")).is_err());
        assert!(same_shortcut(
            Some("CommandOrControl+Alt+Space"),
            "CommandOrControl+Alt+Space"
        ));
        assert!(same_shortcut(Some("Control+Alt+Space"), "ctrl+alt+space"));
        assert!(!same_shortcut(
            Some("CommandOrControl+Alt+Shift+T"),
            "CommandOrControl+Alt+Space"
        ));
        assert!(!same_shortcut(None, "CommandOrControl+Alt+Space"));
        assert!(!same_shortcut(Some("not a shortcut"), "Alt+Space"));
    }

    #[test]
    fn tray_status_accepts_a_clock_and_older_uis_without_it() {
        let status: TrayStatus = serde_json::from_str(
            r#"{"title":"0:05 A","tooltip":"A","status":"s","running":true,"clock":{"startedAt":1,"title":"{time} A","tooltip":"A {time}","todayBaseSeconds":0}}"#,
        )
        .unwrap();
        assert_eq!(status.clock.map(|clock| clock.started_at), Some(1));
        let old: TrayStatus =
            serde_json::from_str(r#"{"title":null,"tooltip":"t","status":"s","running":false}"#)
                .unwrap();
        assert!(old.clock.is_none() && !old.running && old.title.is_none());
    }

    #[test]
    fn tray_click_toggles_the_window() {
        let ms = Duration::from_millis;
        // Looking at it (focused, or it lost the focus to the tray click a moment ago): hide.
        assert!(tray_click_hides(true, false, true, None));
        assert!(tray_click_hides(true, false, false, Some(ms(120))));
        // Hidden, minimised, or behind other windows for a while: bring it forward.
        assert!(!tray_click_hides(false, false, false, None));
        assert!(!tray_click_hides(true, true, false, Some(ms(10))));
        assert!(!tray_click_hides(true, false, false, Some(ms(5_000))));
        assert!(!tray_click_hides(true, false, false, None));
    }

    #[test]
    fn target_uses_tauri_names() {
        assert!(["linux", "windows", "darwin"].contains(&updater_target()));
    }

    #[test]
    fn parses_update_with_min_supported_version() {
        let json = serde_json::to_value(parse_update(
            r#"{"version":"0.2.0","notes":"n","min_supported_version":"0.2.0","url":"u","signature":"s"}"#,
            Some("0.1.5".into()),
            false,
        ))
        .unwrap();
        assert_eq!(json["status"], "available");
        assert_eq!(json["version"], "0.2.0");
        assert_eq!(json["min_supported_version"], "0.2.0");
        assert_eq!(
            serde_json::to_value(parse_update("nope", None, true)).unwrap()["status"],
            "error"
        );
        assert_eq!(
            serde_json::to_value(UpdateCheck::Unauthorized).unwrap()["status"],
            "unauthorized"
        );
    }

    #[test]
    fn header_min_is_used_when_body_has_none() {
        let json = serde_json::to_value(parse_update(
            r#"{"version":"0.3.0"}"#,
            Some("0.2.0".into()),
            true,
        ))
        .unwrap();
        assert_eq!(json["min_supported_version"], "0.2.0");
        assert_eq!(json["installable"], true);
        let up = serde_json::to_value(UpdateCheck::UpToDate {
            min_supported_version: Some("0.1.0".into()),
        })
        .unwrap();
        assert_eq!(up["status"], "up_to_date");
        assert_eq!(up["min_supported_version"], "0.1.0");
    }

    #[test]
    fn validates_server() {
        assert!(validate_server("https://beacon.example.com").is_ok());
        // Loopback http in debug builds only (net::validate_url_with covers the release rule).
        assert_eq!(
            validate_server("http://127.0.0.1:8787").is_ok(),
            cfg!(debug_assertions)
        );
        assert!(validate_server("http://beacon.example.com").is_err());
        assert!(validate_server("https://user:pw@beacon.example.com").is_err());
        assert!(validate_server("file:///etc/passwd").is_err());
    }

    #[test]
    fn updater_authorization_comes_from_the_store_for_its_origin_only() {
        use secret::tests::{session, MemoryStore};
        let a = url::Url::parse("https://beacon.a.example").unwrap();
        let b = url::Url::parse("https://beacon.b.example").unwrap();
        let signed_in = session(&MemoryStore::with(a.as_str(), "secret-token"));
        let value = session_authorization(&signed_in, &a).unwrap().unwrap();
        assert_eq!(value.to_str().unwrap(), "Bearer secret-token");
        assert!(value.is_sensitive());
        assert!(session_authorization(&signed_in, &b).unwrap().is_none());
        assert!(session_authorization(&session(&MemoryStore::default()), &a)
            .unwrap()
            .is_none());
        let bad = session(&MemoryStore::with(a.as_str(), "secret-token\r\n"));
        let locked = MemoryStore::with(a.as_str(), "secret-token");
        locked
            .fail_read
            .store(true, std::sync::atomic::Ordering::SeqCst);
        for error in [
            session_authorization(&bad, &a).unwrap_err(),
            session_authorization(&session(&locked), &a).unwrap_err(),
        ] {
            assert!(!error.contains("secret-token"), "{error}");
        }
    }

    #[test]
    fn no_command_returns_the_session_token() {
        // secret_get / secret_set (0.5.1 and earlier) are gone: the webview can only ask whether a token is stored,
        // start a sign-in and delete the token (secret.rs).
        for gone in ["secret_get", "secret_set"] {
            assert!(!APP_COMMANDS.contains(&gone), "{gone}");
        }
        assert!(MAIN_COMMANDS.contains(&"secret_status"));
        assert!(MAIN_COMMANDS.contains(&"sign_in_begin"));
        assert!(MAIN_COMMANDS.contains(&"secret_delete"));
        let source = include_str!("secret.rs");
        let status = source.find("pub async fn secret_status").unwrap();
        let signature = &source[status..status + source[status..].find('{').unwrap()];
        assert!(
            signature.ends_with("-> Result<bool, String> "),
            "{signature}"
        );
    }

    #[test]
    fn updater_commands_need_the_bound_server() {
        let bound = secret::tests::session(&secret::tests::MemoryStore::default());
        assert!(bound_server(&bound, "https://beacon.example.com").is_err());
        bound
            .bind(&url::Url::parse("https://beacon.example.com").unwrap())
            .unwrap();
        assert!(bound_server(&bound, "https://beacon.example.com/").is_ok());
        assert!(bound_server(&bound, "https://beacon.example.com:8443").is_err());
        assert!(bound_server(&bound, "https://evil.example").is_err());
    }

    #[test]
    fn download_to_other_host_never_gets_the_token() {
        let server = url::Url::parse("https://beacon.example.com").unwrap();
        let bearer = || {
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(AUTHORIZATION, "Bearer secret".parse().unwrap());
            headers
        };
        let mut s3 = bearer();
        let presigned = url::Url::parse("https://bucket.s3.example.net/time-track-clients/desktop/0.2.0/a.AppImage?X-Amz-Signature=x").unwrap();
        strip_token_for_download(&server, &presigned, &mut s3);
        assert!(s3.get(AUTHORIZATION).is_none());
        let mut port = bearer();
        strip_token_for_download(
            &server,
            &url::Url::parse("https://beacon.example.com:8443/a").unwrap(),
            &mut port,
        );
        assert!(port.get(AUTHORIZATION).is_none());
        let mut same = bearer();
        strip_token_for_download(
            &server,
            &url::Url::parse("https://beacon.example.com/download/a").unwrap(),
            &mut same,
        );
        assert!(same.get(AUTHORIZATION).is_some());
    }

    #[test]
    fn placeholder_or_garbage_is_no_key() {
        assert_eq!(usable_pubkey(None), None);
        assert_eq!(usable_pubkey(Some("")), None);
        assert_eq!(usable_pubkey(Some("   ")), None);
        assert_eq!(usable_pubkey(Some(PUBKEY_PLACEHOLDER)), None);
        assert_eq!(
            usable_pubkey(Some("not a key, has spaces and commas, long enough")),
            None
        );
        // Shape of a real `tauri signer generate` public key (base64 of the minisign .pub text); not a real key.
        let shaped =
            "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFCQ0QKUldUQUFBQUFBQUFBQQo=";
        assert_eq!(usable_pubkey(Some(shaped)).as_deref(), Some(shaped));
        assert_eq!(
            usable_pubkey(Some(&format!(" {shaped}\n"))).as_deref(),
            Some(shaped)
        );
    }

    #[test]
    fn only_appimage_nsis_and_app_installs_update_themselves() {
        use tauri::utils::config::BundleType;
        assert_eq!(bundle_name(Some(BundleType::Nsis)), "nsis");
        assert_eq!(bundle_name(Some(BundleType::Msi)), "msi");
        assert_eq!(bundle_name(Some(BundleType::AppImage)), "appimage");
        assert_eq!(bundle_name(Some(BundleType::Deb)), "deb");
        assert_eq!(bundle_name(Some(BundleType::Dmg)), "app");
        assert_eq!(bundle_name(None), "unknown");
        for name in ["nsis", "appimage", "app"] {
            assert!(bundle_self_updates(name), "{name}");
        }
        for name in ["msi", "deb", "rpm", "unknown"] {
            assert!(!bundle_self_updates(name), "{name}");
        }
    }

    #[test]
    fn progress_is_throttled_to_percent_steps() {
        let mut throttle = ProgressThrottle::new();
        assert_eq!(
            throttle.chunk(10, Some(1000)),
            Some(UpdateProgress::Downloading {
                downloaded: 10,
                total: Some(1000)
            })
        );
        assert_eq!(throttle.chunk(5, Some(1000)), None);
        assert!(throttle.chunk(5, Some(1000)).is_some());
        assert!(throttle.chunk(980, Some(1000)).is_some());
        let mut unknown = ProgressThrottle::new();
        assert!(unknown.chunk(100, None).is_some());
        assert_eq!(unknown.chunk(100, None), None);
        assert!(unknown.chunk(1024 * 1024, None).is_some());
        let json = serde_json::to_value(UpdateProgress::Installing).unwrap();
        assert_eq!(json["phase"], "installing");
        let json = serde_json::to_value(UpdateProgress::Downloading {
            downloaded: 1,
            total: None,
        })
        .unwrap();
        assert_eq!(json["phase"], "downloading");
        assert!(json["total"].is_null());
    }

    #[test]
    fn direct_build_is_not_the_store_channel() {
        // Gates run without TIMETRACK_CHANNEL: the direct-download build keeps its updater.
        assert_eq!(
            store_channel(),
            option_env!("TIMETRACK_CHANNEL") == Some("store")
        );
        let disabled = serde_json::to_value(UpdateCheck::Disabled).unwrap();
        assert_eq!(disabled["status"], "disabled");
    }
}
